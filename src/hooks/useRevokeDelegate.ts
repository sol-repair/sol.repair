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
 * land) until the user explicitly dismisses it via reset(). Release is
 * never timer-based.
 *
 * This hook NEVER signs anything itself: the unsigned transaction goes
 * to the wallet adapter and the user approves.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { useRpcConnection } from "@/hooks/useRpcConnection";
import bs58 from "bs58";
import type { Connection, Transaction } from "@solana/web3.js";

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

/** Interval between resolution polls; also spaces the §8.5
 *  corroboration reads. */
const RESOLVE_POLL_INTERVAL_MS = 1500;

/** Bounded in-place retries for transient RPC failures of a single
 *  status query (spec §8.5: reads are retried in place, never
 *  submissions). */
const MAX_STATUS_RPC_ATTEMPTS = 3;

/** Consecutive fully-failed resolution rounds tolerated before the
 *  lifecycle stops and reports uncertainty (spec §8.4 S6). */
const MAX_FAILED_ROUNDS = 3;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type StatusOutcome =
  | { kind: "resolved"; err: unknown }
  | { kind: "unobserved" }
  | { kind: "rpc-failed" };

/**
 * One signature-status query with bounded in-place retries for
 * transient RPC failures. A null (unobserved) answer is ABSENCE OF
 * EVIDENCE, never proof of failure (spec §8.5). Any OBSERVED status —
 * processed, confirmed, or finalized — means the transaction LANDED
 * (spec §8.5 totality): processed is landing too and must route to
 * verification, never fall through as keep-polling.
 */
async function querySignatureStatus(
  connection: Connection,
  signature: string
): Promise<StatusOutcome> {
  for (let attempt = 1; attempt <= MAX_STATUS_RPC_ATTEMPTS; attempt++) {
    try {
      const statuses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: false,
      });
      const status = statuses.value[0];
      if (!status) return { kind: "unobserved" };
      return { kind: "resolved", err: status.err ?? null };
    } catch {
      if (attempt < MAX_STATUS_RPC_ATTEMPTS) {
        await sleep(RESOLVE_POLL_INTERVAL_MS);
      }
    }
  }
  return { kind: "rpc-failed" };
}

async function readBlockHeight(connection: Connection): Promise<number | null> {
  try {
    return await connection.getBlockHeight({ commitment: "confirmed" });
  } catch {
    return null;
  }
}

/** What the §8.5 corroboration pass concluded about a past-the-window
 *  transaction with no observed status. */
type ReadAccount = Extract<DelegatedAccountRead, { kind: "read" }>;
type Corroboration =
  | { type: "standard-met" }
  | { type: "delegate-absent"; read: ReadAccount }
  | { type: "resolved"; err: unknown }
  | { type: "delegate-changed"; current: string }
  | { type: "account-gone" }
  | { type: "cannot-establish"; detail: string };

/**
 * The §8.5 non-landing evidence standard. Called only when a status
 * query came back unobserved AND the block height is already beyond
 * the transaction's window: a spent blockhash proves the transaction
 * cannot land in the FUTURE; non-landing in the past requires
 * corroborated reads — two spaced status queries both unobserved, and
 * two spaced account reads both showing the reviewed delegate present
 * with the identical address. ONE inconsistent observation blocks the
 * re-sign (the asymmetric rule): evidence of an outcome always wins.
 */
async function corroborateNonLanding(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  delegation: RevocableDelegation
): Promise<Corroboration> {
  const readOnce = async (): Promise<
    DelegatedAccountRead | { kind: "rpc-failed" }
  > => {
    try {
      return await readDelegatedAccountState(connection, delegation.pubkey);
    } catch {
      return { kind: "rpc-failed" };
    }
  };

  // Post-close evidence only (spec §8.5, verification fix): the
  // detecting iteration queried the status BEFORE reading the height,
  // so that query is not provably post-close and is NOT counted. The
  // standard's two spaced status queries start HERE, now that the
  // window is known to be closed — the first of them immediately, the
  // second one poll interval later.
  const status1 = await querySignatureStatus(connection, signature);
  if (status1.kind === "resolved") {
    return { type: "resolved", err: status1.err };
  }
  if (status1.kind === "rpc-failed") {
    return {
      type: "cannot-establish",
      detail: "the signature status could not be read",
    };
  }

  // First corroboration read.
  const read1 = await readOnce();
  if (read1.kind === "rpc-failed" || read1.kind === "unreadable") {
    return { type: "cannot-establish", detail: "the account read failed" };
  }
  if (read1.kind === "missing") {
    // The window is provably closed here: the honest terminal is
    // "the account is gone", never "it may still land" (§8.9).
    return { type: "account-gone" };
  }
  if (read1.delegate === null) {
    return { type: "delegate-absent", read: read1 };
  }
  if (read1.delegate !== delegation.delegate) {
    return { type: "delegate-changed", current: read1.delegate };
  }

  // Space the rounds (the standard: SPACED queries and reads).
  await sleep(RESOLVE_POLL_INTERVAL_MS);

  // Second status query: an outcome resolving now always wins.
  const status2 = await querySignatureStatus(connection, signature);
  if (status2.kind === "resolved") {
    return { type: "resolved", err: status2.err };
  }
  if (status2.kind === "rpc-failed") {
    return {
      type: "cannot-establish",
      detail: "the signature status could not be read",
    };
  }

  // Second height check: the window must still be past.
  const height2 = await readBlockHeight(connection);
  if (height2 === null) {
    return {
      type: "cannot-establish",
      detail: "the block height could not be read",
    };
  }
  if (height2 <= lastValidBlockHeight) {
    // Height disagreement — the view cannot currently distinguish
    // landed from not-landed (spec §8.5, RPC disagreement).
    return {
      type: "cannot-establish",
      detail: "the block height moved back inside the transaction window",
    };
  }

  // Second account read: must agree with the first.
  const read2 = await readOnce();
  if (read2.kind === "rpc-failed" || read2.kind === "unreadable") {
    return { type: "cannot-establish", detail: "the account read failed" };
  }
  if (read2.kind === "missing") {
    return { type: "account-gone" };
  }
  if (read2.delegate === null) {
    return { type: "delegate-absent", read: read2 };
  }
  if (
    read2.delegate !== delegation.delegate ||
    read2.delegate !== read1.delegate
  ) {
    return { type: "delegate-changed", current: read2.delegate };
  }

  // Every observation is consistent with a transaction that never
  // landed. Unanimous — the standard is met.
  return { type: "standard-met" };
}

/** How resolving ONE signed transaction ended (spec §8.4 states). */
type Resolution =
  | { type: "confirmed" }
  | { type: "on-chain-error" }
  | { type: "expired-standard-met" }
  | { type: "delegate-absent"; read: ReadAccount }
  | { type: "delegate-changed"; current: string }
  | { type: "account-gone" }
  | { type: "unresolved"; detail: string };

/**
 * Resolve ONE signed, (possibly) submitted transaction to an §8.4
 * state, by evidence only (spec §8.5). The send step has already
 * happened — or failed — before this runs; a send error classifies
 * nothing.
 */
async function resolveTransaction(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  delegation: RevocableDelegation,
  setRunState: (patch: Partial<RevokeState>) => void
): Promise<Resolution> {
  let failedRounds = 0;
  for (;;) {
    const status = await querySignatureStatus(connection, signature);
    // Totality: an observed status means the transaction landed — at
    // processed, confirmed, OR finalized commitment. It routes to the
    // verify path (or the on-chain-error report) and never falls
    // through as keep-polling.
    if (status.kind === "resolved") {
      return status.err !== null
        ? { type: "on-chain-error" }
        : { type: "confirmed" };
    }

    const height = await readBlockHeight(connection);
    if (height !== null && height > lastValidBlockHeight) {
      if (status.kind === "unobserved") {
        setRunState({
          status: "confirming",
          note: "Checking the chain for what actually landed...",
        });
        const verdict = await corroborateNonLanding(
          connection,
          signature,
          lastValidBlockHeight,
          delegation
        );
        switch (verdict.type) {
          case "standard-met":
            return { type: "expired-standard-met" };
          case "delegate-absent":
            return { type: "delegate-absent", read: verdict.read };
          case "delegate-changed":
            return { type: "delegate-changed", current: verdict.current };
          case "resolved":
            return verdict.err !== null
              ? { type: "on-chain-error" }
              : { type: "confirmed" };
          case "account-gone":
            return { type: "account-gone" };
          case "cannot-establish":
            return { type: "unresolved", detail: verdict.detail };
        }
      }
      // status rpc-failed past the window: the standard cannot even
      // start, so this round is unresolvable — counted below.
    }

    // Window still open (or height unreadable): keep resolving. A
    // round that could not gather classifiable evidence — the status
    // stream down, or no status and no readable height — counts
    // toward the bounded stop; any progress resets it.
    const unresolvable =
      status.kind === "rpc-failed" ||
      (status.kind === "unobserved" && height === null);
    if (unresolvable) {
      failedRounds += 1;
      if (failedRounds >= MAX_FAILED_ROUNDS) {
        return {
          type: "unresolved",
          detail: "the RPC could not be reached to establish the outcome",
        };
      }
    } else {
      failedRounds = 0;
    }
    await sleep(RESOLVE_POLL_INTERVAL_MS);
  }
}

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
            const message =
              signError instanceof Error
                ? signError.message
                : String(signError);
            const lower = message.toLowerCase();
            if (lower.includes("rejected")) {
              throw new FriendlyError(
                "Transaction cancelled. Nothing was sent."
              );
            }
            if (/blockhash|block height|blockheight|expired/i.test(message)) {
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
            delegation,
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

          if (resolution.type === "delegate-absent") {
            // The delegate is gone but no confirmed signature status
            // exists: the state is good, causation is not claimed
            // (spec §8.9 row 7).
            setRunState({
              status: "done",
              outcome: "delegate-absent-unattributed",
              balanceAfterAction: resolution.read.balance,
              delegatePresentAtLastRead: false,
              error:
                "The delegate is no longer on this account. Whether this app's transaction caused that could not be established.",
            });
            return;
          }

          if (resolution.type === "delegate-changed") {
            setRunState({
              status: "error",
              outcome: "gate-state-changed",
              error: `The delegate on this account is now a different address (${resolution.current}). The permission you reviewed is out of date. Rescan to see the current state.`,
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
        if (!holdLockForDismissal) {
          releaseAction("revoke");
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
