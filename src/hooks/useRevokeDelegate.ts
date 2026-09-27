"use client";

/**
 * useRevokeDelegate: React hook that builds, submits, and verifies the
 * G.2 delegate-revocation transaction for ONE funded token account
 * (spec §8).
 *
 * Lifecycle: gate → build → sign → send → resolve → verify, with four
 * honest terminal outcomes: revoked-verified, already-revoked (nothing
 * signed), delegate-absent-unattributed (state good, causation
 * unproven), error-with-cause, and unverified (cannot-verify — never
 * folded into success or failure).
 *
 * What this hook deliberately does NOT copy from useRepairWallet
 * (spec §8.5): the repair classifies failures by error-message shape
 * and re-verifies closed accounts. This hook classifies every
 * post-signature outcome by EVIDENCE — signature-status queries,
 * blockhash-height readings, and account reads — and permits its
 * single re-sign only when the §8.5 non-landing evidence standard is
 * met (corroborated spaced reads, unanimous non-landing evidence,
 * delegate-identity re-check). Message shapes are used in exactly one
 * place: classifying a sign-stage refusal, where no signature exists
 * and nothing can land. An RPC timeout never triggers a submission.
 *
 * Mutual exclusion (spec §8.12): a module-scoped lock shared with the
 * repair hook is acquired synchronously before the first await. The
 * lock is released in `finally` at provably safe terminals — and held
 * past `unverified / unresolved-outcome` (a transaction that may still
 * land) until the user explicitly dismisses it via reset(), or until
 * the hook unmounts, whichever comes first (past an unmount no
 * dismissal card exists). Release is never timer-based.
 *
 * This hook NEVER signs anything itself: the unsigned transaction goes
 * to the wallet adapter and the user approves.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { useRpcConnection } from "@/hooks/useRpcConnection";
import bs58 from "bs58";
import type { Transaction } from "@solana/web3.js";

import { acquireAction, heldAction, releaseAction } from "@/lib/actionMutex";
import {
  ALREADY_REVOKED_COPY,
  buildRevokeInstruction,
  evaluateDelegationGate,
  gateAbortSentence,
  readDelegatedAccountState,
  type DelegatedAccountRead,
  type RevocableDelegation,
} from "@/lib/solana/revokeDelegation";
import { buildTransaction } from "@/lib/solana/transactions";
import {
  classifySignRefusal,
  corroborateNonLanding,
  RESOLVE_POLL_INTERVAL_MS,
  resolveTransaction,
  sleep,
  type CorroborationRead,
  type CorroborationVerdict,
} from "@/lib/solana/actionLifecycle";

export type RevokeStatus =
  | "idle"
  | "checking-current-state"
  | "building"
  | "awaiting-signature"
  | "sending"
  | "confirming"
  | "verifying"
  | "done"
  | "error"
  | "unverified";

export type RevokeOutcome =
  // done
  | "already-revoked"
  | "revoked-verified"
  | "delegate-absent-unattributed"
  // error
  | "gate-state-changed"
  | "cancelled"
  | "expired"
  | "on-chain-failure"
  | "action-conflict"
  | "delegate-reapproved-after"
  | "account-gone"
  // unverified
  | "unresolved-outcome"
  | "confirmed-verification-unavailable";

export interface RevokeState {
  status: RevokeStatus;
  outcome: RevokeOutcome | null;
  /** All submitted signatures, oldest first (dead ones included:
   *  they are explorable receipts). */
  signatures: string[];
  accountPubkey: string | null;
  /** The reviewed delegate address. */
  delegate: string | null;
  balanceAtScan: string | null;
  balanceBeforeAction: string | null;
  balanceAfterAction: string | null;
  delegatePresentAtLastRead: boolean | null;
  /** Attempt-stage message (e.g. the fresh-transaction retry note). */
  note: string | null;
  error: string | null;
  errorDetail: string | null;
}

const INITIAL_STATE: RevokeState = {
  status: "idle",
  outcome: null,
  signatures: [],
  accountPubkey: null,
  delegate: null,
  balanceAtScan: null,
  balanceBeforeAction: null,
  balanceAfterAction: null,
  delegatePresentAtLastRead: null,
  note: null,
  error: null,
  errorDetail: null,
};

/** An error whose message is ALREADY user-facing copy (house pattern).
 *  Carries the terminal outcome it maps to, so the catch cannot
 *  overwrite an expired-refusal report with a cancelled one. */
class FriendlyError extends Error {
  outcome: RevokeOutcome;
  constructor(message: string, outcome: RevokeOutcome = "cancelled") {
    super(message);
    this.outcome = outcome;
  }
}

/** The revoke-specific corroboration verdicts: the shared base already
 *  covers standard-met / resolved / account-gone / cannot-establish;
 *  these two carry the delegate evidence the §8.9 mapping needs. */
type ReadAccount = Extract<DelegatedAccountRead, { kind: "read" }>;
type RevokeCorroboration =
  | { type: "delegate-absent"; read: ReadAccount }
  | { type: "delegate-changed"; current: string };

/** The in-flight statuses for the cross-action affordance (§8.12). */
const IN_FLIGHT_STATUSES: ReadonlySet<RevokeStatus> = new Set([
  "checking-current-state",
  "building",
  "awaiting-signature",
  "sending",
  "confirming",
  "verifying",
]);

export function useRevokeDelegate() {
  const connection = useRpcConnection();
  const wallet = useWallet();

  const [state, setState] = useState<RevokeState>(INITIAL_STATE);

  // Synchronous in-flight flag (house pattern): a second revoke()
  // while one runs is a no-op, and the guard is released in `finally`
  // even on failure.
  const revokeInFlight = useRef(false);

  // Live public key mirrored through a ref so an in-flight action can
  // detect a wallet switch (the repair hook's B1 pattern).
  const livePublicKeyRef = useRef(wallet.publicKey);
  useEffect(() => {
    livePublicKeyRef.current = wallet.publicKey;
  }, [wallet.publicKey]);

  // Current status readable from reset() — the dismissal path that is
  // allowed to release the unresolved-outcome hold (§8.12 rule 2).
  const statusRef = useRef<RevokeStatus>("idle");
  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  // The unresolved-outcome hold is owned by THIS instance: set when the
  // action acquires the mutex, cleared when that action's finally (or
  // the dismissal reset) releases it. The unmount cleanup below refuses
  // to release any hold this instance did not acquire.
  const holdsLockRef = useRef(false);
  // Set once the component unmounts (client-side navigation). An action
  // still running past the unmount can no longer show a dismissal card,
  // so its unresolved terminal must not keep the mutex.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (
        holdsLockRef.current &&
        statusRef.current === "unverified" &&
        heldAction() === "revoke"
      ) {
        releaseAction("revoke");
        holdsLockRef.current = false;
      }
    };
  }, []);

  const revoke = useCallback(
    async (delegation: RevocableDelegation) => {
      if (revokeInFlight.current) return;
      revokeInFlight.current = true;

      // The one unresolved terminal keeps the lock until the user
      // dismisses it (§8.12 rule 2); every other terminal releases in
      // the finally below.
      let holdLockForDismissal = false;

      try {
        if (!wallet.publicKey || !wallet.signTransaction) {
          setState({
            ...INITIAL_STATE,
            status: "error",
            outcome: "cancelled",
            error: "Wallet not connected or does not support signing.",
          });
          return;
        }
        // Synchronous cross-action mutex (spec §8.12). The local ref
        // guard above already no-ops same-hook re-entry; this acquire
        // is only reachable when the REPAIR flow holds the lock.
        if (!acquireAction("revoke")) {
          setState({
            ...INITIAL_STATE,
            status: "error",
            outcome: "action-conflict",
            error: "Another wallet action is underway. Wait for it to finish.",
          });
          return;
        }
        holdsLockRef.current = true;

        // Pin the identity for the whole action (house pattern).
        const actionOwner = wallet.publicKey;
        const signer = wallet.signTransaction;

        const setRunState = (
          patch:
            | Partial<RevokeState>
            | ((prev: RevokeState) => Partial<RevokeState>)
        ) =>
          setState((prev) =>
            typeof patch === "function"
              ? { ...prev, ...patch(prev) }
              : { ...prev, ...patch }
          );

        setState({
          ...INITIAL_STATE,
          status: "checking-current-state",
          accountPubkey: delegation.pubkey,
          delegate: delegation.delegate,
          balanceAtScan: delegation.balanceAtScan,
        });

        // ---- Step 2: the refresh gate (spec §8.3) ----
        let gateRead: DelegatedAccountRead;
        try {
          gateRead = await readDelegatedAccountState(
            connection,
            delegation.pubkey
          );
        } catch {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            error:
              "The current account state could not be read. Nothing was signed.",
          });
          return;
        }
        const verdict = evaluateDelegationGate(
          gateRead,
          delegation.delegate,
          actionOwner.toBase58()
        );
        if (verdict.kind === "abort") {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            error: gateAbortSentence(verdict),
          });
          return;
        }
        if (verdict.kind === "already-absent") {
          setRunState({
            status: "done",
            outcome: "already-revoked",
            balanceBeforeAction: verdict.balanceBeforeAction,
            delegatePresentAtLastRead: false,
            error: ALREADY_REVOKED_COPY,
          });
          return;
        }
        // Gate passed. A balance drift vs the scan is NOT an abort
        // (review-confirmed Case B): it travels to the card and the
        // user consents with current numbers.
        const balanceBeforeAction = verdict.balanceBeforeAction;
        setRunState({ balanceBeforeAction });

        // ---- Steps 3-9, with the single §8.5 re-sign budget ----
        let reSignUsed = false;
        let refusalRetryUsed = false;
        let lastResolutionNote: string | null = null;

        // The §8.5 corroboration policy for one read: the delegate
        // field is the identity being judged (the asymmetric rule —
        // one inconsistent observation terminalizes corroboration and
        // blocks the re-sign). Revoke's checks are per-read, so the
        // second call's `prior` read is unused: read1's delegate
        // already matched the reviewed one, so any read2 disagreement
        // with the reviewed delegate is caught by the same check.
        const readOnce = async (): Promise<CorroborationRead<ReadAccount>> => {
          try {
            const read = await readDelegatedAccountState(
              connection,
              delegation.pubkey
            );
            if (read.kind === "read") return { kind: "read", value: read };
            if (read.kind === "missing") return { kind: "missing" };
            return { kind: "unusable" };
          } catch {
            return { kind: "unusable" };
          }
        };
        const judge = (
          read: ReadAccount
        ): CorroborationVerdict<RevokeCorroboration> | null => {
          if (read.delegate === null) {
            return { type: "delegate-absent", read };
          }
          if (read.delegate !== delegation.delegate) {
            return { type: "delegate-changed", current: read.delegate };
          }
          return null;
        };

        // Sign-stage classification (spec §8.5): message shapes are
        // used ONLY here, where no signature exists and nothing can
        // land. Rejection → cancelled; expiry-shaped refusal → one
        // fresh build+sign (nothing was ever signed, so a retry
        // cannot duplicate anything).
        const build = async () => {
          const instruction = buildRevokeInstruction(
            delegation,
            actionOwner
          );
          return buildTransaction(connection, actionOwner, [instruction]);
        };

        for (;;) {
          const liveBeforeBuild = livePublicKeyRef.current;
          if (!liveBeforeBuild || !liveBeforeBuild.equals(actionOwner)) {
            throw new FriendlyError(
              "The connected wallet changed. Stopped before signing anything."
            );
          }

          setRunState({
            status: "building",
            note: lastResolutionNote,
          });
          const unsigned = await build();

          const liveBeforeSign = livePublicKeyRef.current;
          if (!liveBeforeSign || !liveBeforeSign.equals(actionOwner)) {
            throw new FriendlyError(
              "The connected wallet changed. Stopped before signing anything."
            );
          }

          setRunState({ status: "awaiting-signature" });
          let signed: Transaction;
          try {
            signed = await signer(unsigned);
          } catch (signError) {
            const refusal = classifySignRefusal(signError);
            if (refusal === "rejected") {
              throw new FriendlyError(
                "Transaction cancelled. Nothing was sent."
              );
            }
            if (refusal === "expired-refusal") {
              if (!refusalRetryUsed) {
                refusalRetryUsed = true;
                lastResolutionNote =
                  "The wallet refused the request: the transaction had expired. Nothing was signed. Retrying once with a fresh transaction.";
                continue;
              }
              throw new FriendlyError(
                "The wallet refused the request: the transaction had expired. Nothing was signed.",
                "expired"
              );
            }
            const message =
              signError instanceof Error
                ? signError.message
                : String(signError);
            const raw = new Error(message);
            raw.name = signError instanceof Error ? signError.name : "Error";
            throw raw;
          }

          const signatureBytes = signed.signatures[0]?.signature;
          if (!signatureBytes) {
            throw new FriendlyError(
              "Wallet returned a transaction without a signature. Nothing was sent."
            );
          }
          const signature = bs58.encode(signatureBytes);
          setRunState((prev) => ({
            status: "sending",
            signatures: [...prev.signatures, signature],
            note: null,
          }));

          // Send. The error classifies NOTHING (spec §8.7): the
          // wallet may have self-submitted; the loop asks the chain.
          const lastValidBlockHeight = unsigned.lastValidBlockHeight!;
          try {
            await connection.sendRawTransaction(signed.serialize());
          } catch {
            // fall through to the evidence loop
          }

          setRunState({ status: "confirming" });
          const resolution = await resolveTransaction(
            connection,
            signature,
            lastValidBlockHeight,
            () =>
              corroborateNonLanding(
                connection,
                signature,
                lastValidBlockHeight,
                readOnce,
                judge
              ),
            setRunState
          );

          if (resolution.type === "confirmed") {
            // ---- Step 9: independent verification (spec §8.9) ----
            setRunState({ status: "verifying" });
            // Settle: one poll interval lets the confirmed-commitment
            // view pass the landing slot before the delegate field is
            // judged (a processed-only status can land here).
            await sleep(RESOLVE_POLL_INTERVAL_MS);
            const tryVerificationRead = async (): Promise<DelegatedAccountRead> => {
              try {
                return await readDelegatedAccountState(
                  connection,
                  delegation.pubkey
                );
              } catch {
                return { kind: "unreadable" };
              }
            };
            const firstRead = await tryVerificationRead();
            if (firstRead.kind === "read" && firstRead.delegate === null) {
              setRunState({
                balanceAfterAction: firstRead.balance,
                status: "done",
                outcome: "revoked-verified",
                delegatePresentAtLastRead: false,
              });
              return;
            }
            // One spaced corroborating read before any scary terminal
            // (spec §8.9 row 4 note): a single lagging read must not
            // produce one.
            await sleep(RESOLVE_POLL_INTERVAL_MS);
            const secondRead = await tryVerificationRead();
            if (secondRead.kind === "read") {
              if (secondRead.delegate === null) {
                setRunState({
                  balanceAfterAction: secondRead.balance,
                  status: "done",
                  outcome: "revoked-verified",
                  delegatePresentAtLastRead: false,
                });
                return;
              }
              // Confirmed revoke, yet a delegate is on the account:
              // the delegate field was set again after it landed.
              // Observed and reported without naming any actor (the
              // §6.3 attribution ban); documented edge of §8.9 row 4.
              setRunState({
                status: "error",
                outcome: "delegate-reapproved-after",
                delegatePresentAtLastRead: true,
                balanceAfterAction: secondRead.balance,
                error:
                  "The transaction was confirmed by the network, but a fresh read shows a delegate on this account. SOL.REPAIR cannot tell what set it. Nothing more will be sent automatically.",
              });
              return;
            }
            setRunState({
              status: "unverified",
              outcome: "confirmed-verification-unavailable",
              error:
                secondRead.kind === "missing"
                  ? "The transaction was confirmed by the network, but the account could no longer be read, so the delegate field could not be verified."
                  : "The transaction was confirmed by the network, but the follow-up read of the delegate field failed, so the revocation itself is unverified.",
            });
            return;
          }

          if (resolution.type === "on-chain-error") {
            // Atomic revert: the transaction changed nothing. Report
            // the failure separately from any account observation
            // (spec §8.9 row 6).
            let presentAfter: boolean | null = null;
            try {
              const after = await readDelegatedAccountState(
                connection,
                delegation.pubkey
              );
              if (after.kind === "read") {
                presentAfter = after.delegate !== null;
              }
            } catch {
              // observation unavailable; stated as such
            }
            setRunState({
              status: "error",
              outcome: "on-chain-failure",
              delegatePresentAtLastRead: presentAfter,
              error:
                "The transaction was confirmed on-chain but failed. It changed nothing.",
            });
            return;
          }

          if (resolution.type === "domain") {
            // Revoke's own corroboration verdicts (§8.9 rows 7 and 5).
            if (resolution.verdict.type === "delegate-absent") {
              // The delegate is gone but no confirmed signature status
              // exists: the state is good, causation is not claimed
              // (spec §8.9 row 7).
              setRunState({
                status: "done",
                outcome: "delegate-absent-unattributed",
                balanceAfterAction: resolution.verdict.read.balance,
                delegatePresentAtLastRead: false,
                error:
                  "The delegate is no longer on this account. Whether this app's transaction caused that could not be established.",
              });
              return;
            }
            setRunState({
              status: "error",
              outcome: "gate-state-changed",
              error: `The delegate on this account is now a different address (${resolution.verdict.current}). The permission you reviewed is out of date. Rescan to see the current state.`,
            });
            return;
          }

          if (resolution.type === "account-gone") {
            // Distinct from the unresolved card (§8.9 row 9): the
            // window is provably closed here, so "may still land"
            // would be false.
            setRunState({
              status: "error",
              outcome: "account-gone",
              error:
                "The transaction expired without landing, and the account could not be found when we checked, so the delegate state could not be read. Nothing more will be sent automatically.",
            });
            return;
          }

          if (resolution.type === "unresolved") {
            // The ONE terminal that may still be in flight: hold the
            // lock until the user explicitly dismisses (§8.12 rule 2).
            holdLockForDismissal = true;
            setRunState({
              status: "unverified",
              outcome: "unresolved-outcome",
              errorDetail: resolution.detail,
              error:
                "We could not verify whether the revoke landed. The transaction's outcome could not be established. It may still land. Nothing more will be sent automatically.",
            });
            return;
          }

          // expired-standard-met: provable non-landing, corroborated.
          if (reSignUsed) {
            // Second expiry: stop, with the delegate observation
            // (spec §8.9 row 8 — or row 7 if the observation shows the
            // delegate already gone).
            let observation: DelegatedAccountRead | null = null;
            try {
              const after = await readDelegatedAccountState(
                connection,
                delegation.pubkey
              );
              if (after.kind === "read") observation = after;
            } catch {
              // observation unavailable; stated as such
            }
            if (observation && observation.delegate === null) {
              setRunState({
                status: "done",
                outcome: "delegate-absent-unattributed",
                balanceAfterAction: observation.balance,
                delegatePresentAtLastRead: false,
                error:
                  "The delegate is no longer on this account. Whether this app's transaction caused that could not be established.",
              });
              return;
            }
            setRunState({
              status: "error",
              outcome: "expired",
              delegatePresentAtLastRead:
                observation === null ? null : observation.delegate !== null,
              error:
                observation === null
                  ? "The transaction expired again and was not retried further. The follow-up read failed, so the current delegate state is unknown."
                  : "The transaction expired again and was not retried further. When we checked, the delegate was still on the account.",
            });
            return;
          }
          reSignUsed = true;
          lastResolutionNote =
            "The transaction expired before the network confirmed it. Nothing landed. Retrying once with a fresh transaction. Your approval is required again.";
          // loop: fresh build + fresh explicit approval (§8.5 step 4)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const friendly = err instanceof FriendlyError;
        setState((prev) => ({
          ...prev,
          status: "error",
          outcome: friendly ? err.outcome : "cancelled",
          note: null,
          // Raw library text only surfaces when the copy does not
          // already explain the cause (house pattern).
          error: friendly
            ? message
            : "The revoke could not be prepared. Nothing was signed or sent.",
          errorDetail: friendly ? null : message,
        }));
      } finally {
        // The unresolved hold survives only while the dismissal card is
        // mounted. Past an unmount no card can ever be shown, so the
        // hold releases there instead of orphaning the mutex against
        // the remounted page.
        if (!holdLockForDismissal || unmountedRef.current) {
          releaseAction("revoke");
          holdsLockRef.current = false;
        }
        revokeInFlight.current = false;
      }
    },
    [connection, wallet]
  );

  const reset = useCallback(() => {
    // Dismissing the unresolved-outcome card is the ONE user event
    // that releases the held lock (§8.12 rule 2). Any other reset
    // leaves the lock alone — a mid-flight reset is a UI misuse the
    // in-flight guard already prevents.
    if (statusRef.current === "unverified" && heldAction() === "revoke") {
      releaseAction("revoke");
      holdsLockRef.current = false;
    }
    setState(INITIAL_STATE);
  }, []);

  const actionInFlight =
    IN_FLIGHT_STATUSES.has(state.status) ||
    (state.status === "unverified" && state.outcome === "unresolved-outcome");

  return {
    ...state,
    actionInFlight,
    revoke,
    reset,
  };
}
