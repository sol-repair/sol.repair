"use client";

/**
 * useBurnDust: the dust burn-and-close action hook
 * (docs/dust-zeroing-spec-draft.md, Revision 1).
 *
 * Mirrors useUnwrapNative structurally on purpose — the same evidence
 * lifecycle, the same one-re-sign budget, the same §8.5 corroboration
 * standard, the same §8.11 lock hold on the unresolved terminal — with
 * the burn substitutions:
 *   - the action kind is "burn" in the cross-action mutex;
 *   - the gate is evaluateBurnGate (frozen and native abort; balance
 *     and lamports drift is Case B, consented with current figures);
 *   - the builder is burn-then-close from the gate's current balance;
 *   - the 1% fee rides AFTER the close when the page's feeReady says
 *     the fee account exists (the owner's Q1 ruling; the repair model).
 *
 * This hook NEVER signs anything itself. It hands the unsigned
 * transaction to the wallet adapter for the user to approve.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { useRpcConnection } from "@/hooks/useRpcConnection";
import bs58 from "bs58";
import type { Transaction } from "@solana/web3.js";

import { acquireAction, heldAction, releaseAction } from "@/lib/actionMutex";
import { buildFeeTransfer } from "@/lib/solana/fees";
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
import {
  ALREADY_EMPTY_COPY,
  ALREADY_GONE_COPY,
  BURN_GATE_ABORT_COPY,
  buildBurnDustInstructions,
  evaluateBurnGate,
  readNativeAccountState,
  type BurnableDustAccount,
  type BurnGateVerdict,
  type NativeAccountRead,
} from "@/lib/solana/burnDust";

export type BurnStatus =
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

export type BurnOutcome =
  // done
  | "burn-verified"
  | "already-gone"
  | "already-empty"
  | "close-unattributed"
  // error
  | "gate-state-changed"
  | "cancelled"
  | "expired"
  | "on-chain-failure"
  | "action-conflict"
  | "recreated-after-close"
  // unverified
  | "unresolved-outcome"
  | "confirmed-verification-unavailable";

export interface BurnState {
  status: BurnStatus;
  outcome: BurnOutcome | null;
  signatures: string[];
  accountPubkey: string | null;
  balanceAtScan: string | null;
  lamportsAtScan: number | null;
  balanceBeforeAction: string | null;
  lamportsBeforeAction: number | null;
  accountPresentAfterAction: boolean | null;
  delegatePresent: boolean | null;
  note: string | null;
  error: string | null;
  errorDetail: string | null;
}

const INITIAL_STATE: BurnState = {
  status: "idle",
  outcome: null,
  signatures: [],
  accountPubkey: null,
  balanceAtScan: null,
  lamportsAtScan: null,
  balanceBeforeAction: null,
  lamportsBeforeAction: null,
  accountPresentAfterAction: null,
  delegatePresent: null,
  note: null,
  error: null,
  errorDetail: null,
};

/** The read shape the corroboration judge and the verification reads
 *  narrow to. */
type ReadAccount = Extract<NativeAccountRead, { kind: "read" }>;

class FriendlyError extends Error {
  outcome: BurnOutcome;
  constructor(message: string, outcome: BurnOutcome = "cancelled") {
    super(message);
    this.outcome = outcome;
  }
}

/** The in-flight statuses for the cross-action affordance. */
const IN_FLIGHT_STATUSES: ReadonlySet<BurnStatus> = new Set([
  "checking-current-state",
  "building",
  "awaiting-signature",
  "sending",
  "confirming",
  "verifying",
]);

export function useBurnDust() {
  const connection = useRpcConnection();
  const wallet = useWallet();

  const [state, setState] = useState<BurnState>(INITIAL_STATE);

  const burnInFlight = useRef(false);

  const livePublicKeyRef = useRef(wallet.publicKey);
  useEffect(() => {
    livePublicKeyRef.current = wallet.publicKey;
  }, [wallet.publicKey]);

  const statusRef = useRef<BurnStatus>("idle");
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
        heldAction() === "burn"
      ) {
        releaseAction("burn");
        holdsLockRef.current = false;
      }
    };
  }, []);

  const burn = useCallback(
    async (candidate: BurnableDustAccount, feeReady: boolean) => {
      if (burnInFlight.current) return;
      burnInFlight.current = true;

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
        if (!acquireAction("burn")) {
          setState({
            ...INITIAL_STATE,
            status: "error",
            outcome: "action-conflict",
            error: "Another wallet action is underway. Wait for it to finish.",
          });
          return;
        }
        holdsLockRef.current = true;

        const actionOwner = wallet.publicKey;
        const signer = wallet.signTransaction;

        const setRunState = (
          patch:
            | Partial<BurnState>
            | ((prev: BurnState) => Partial<BurnState>)
        ) =>
          setState((prev) =>
            typeof patch === "function"
              ? { ...prev, ...patch(prev) }
              : { ...prev, ...patch }
          );

        setState({
          ...INITIAL_STATE,
          status: "checking-current-state",
          accountPubkey: candidate.pubkey,
          balanceAtScan: candidate.amountAtScan,
          lamportsAtScan: candidate.lamports,
        });

        // ---- The refresh gate (authoritative, in-lock) ----
        let gateRead: NativeAccountRead;
        try {
          gateRead = await readNativeAccountState(
            connection,
            candidate.pubkey
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
        const verdict: BurnGateVerdict = evaluateBurnGate(
          gateRead,
          candidate.mint,
          actionOwner.toBase58()
        );
        if (verdict.kind === "abort") {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            error: BURN_GATE_ABORT_COPY[verdict.reason],
          });
          return;
        }
        if (verdict.kind === "already-gone") {
          setRunState({
            status: "done",
            outcome: "already-gone",
            accountPresentAfterAction: false,
            error: ALREADY_GONE_COPY,
          });
          return;
        }
        if (verdict.kind === "already-empty") {
          setRunState({
            status: "done",
            outcome: "already-empty",
            accountPresentAfterAction: true,
            error: ALREADY_EMPTY_COPY,
          });
          return;
        }
        // Gate passed. Balance/lamports drift vs the scan is NOT an
        // abort (Case B policy): the figures travel to the card and the
        // user consents with current numbers. A delegate present is not
        // an abort either: the owner can always burn their own balance,
        // and the delegation ends with the close.
        setRunState({
          balanceBeforeAction: verdict.balanceBeforeAction,
          lamportsBeforeAction: verdict.lamportsBeforeAction,
          delegatePresent: verdict.delegate !== null,
        });

        // ---- Sign-and-resolve loop, with the single re-sign budget ----
        let reSignUsed = false;
        let refusalRetryUsed = false;
        let lastResolutionNote: string | null = null;

        // The §8.5 corroboration policy for one read, with the burn
        // substitutions: the token identity is judged on every read
        // (confirmed non-native, not frozen), and the lamports figure
        // on the second (prior !== null) — one inconsistent
        // observation blocks the re-sign.
        const readOnce = async (): Promise<CorroborationRead<ReadAccount>> => {
          try {
            const read = await readNativeAccountState(
              connection,
              candidate.pubkey
            );
            if (read.kind === "read") return { kind: "read", value: read };
            if (read.kind === "missing") return { kind: "missing" };
            return { kind: "unusable" };
          } catch {
            return { kind: "unusable" };
          }
        };
        const judge = (
          read: ReadAccount,
          prior: ReadAccount | null
        ): CorroborationVerdict | null => {
          if (read.nativeStatus !== "non-native" || read.state === "frozen") {
            return {
              type: "cannot-establish",
              detail: "the account read could not confirm the token identity",
            };
          }
          if (prior && prior.lamports !== read.lamports) {
            return {
              type: "cannot-establish",
              detail:
                "the account's lamports changed between the two corroboration reads, so its continuity is not established",
            };
          }
          return null;
        };

        const build = async () => {
          const instructions = buildBurnDustInstructions(
            {
              ...candidate,
              amountBeforeAction: verdict.balanceBeforeAction,
            },
            actionOwner
          );
          // The 1% fee rides AFTER the close, per the owner's Q1
          // ruling, gated on the page's feeReady decision exactly like
          // the repair. The fee base is the account's lamports — the
          // rent the close frees.
          if (feeReady) {
            const fee = buildFeeTransfer(actionOwner, [
              {
                pubkey: candidate.pubkey,
                mint: candidate.mint,
                lamports: verdict.lamportsBeforeAction,
                program: candidate.program,
              },
            ]);
            if (fee) instructions.push(fee);
          }
          return buildTransaction(connection, actionOwner, instructions);
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
            // ---- Independent verification ----
            setRunState({ status: "verifying" });
            await sleep(RESOLVE_POLL_INTERVAL_MS);
            const tryVerificationRead = async (): Promise<NativeAccountRead> => {
              try {
                return await readNativeAccountState(
                  connection,
                  candidate.pubkey
                );
              } catch {
                return { kind: "unreadable" };
              }
            };
            const firstRead = await tryVerificationRead();
            if (firstRead.kind === "missing") {
              setRunState({
                accountPresentAfterAction: false,
                status: "done",
                outcome: "burn-verified",
              });
              return;
            }
            // One spaced corroborating read before any scary terminal.
            await sleep(RESOLVE_POLL_INTERVAL_MS);
            const secondRead = await tryVerificationRead();
            if (secondRead.kind === "missing") {
              setRunState({
                accountPresentAfterAction: false,
                status: "done",
                outcome: "burn-verified",
              });
              return;
            }
            if (secondRead.kind === "read") {
              setRunState({
                accountPresentAfterAction: true,
                status: "error",
                outcome: "recreated-after-close",
                error:
                  "The transaction was confirmed by the network, but a fresh read shows an account at this address again. SOL.REPAIR cannot tell what created it. Nothing more will be sent automatically.",
              });
              return;
            }
            setRunState({
              accountPresentAfterAction: null,
              status: "unverified",
              outcome: "confirmed-verification-unavailable",
              error:
                "The transaction was confirmed by the network, but the follow-up read failed, so the burn is unverified.",
            });
            return;
          }

          if (resolution.type === "on-chain-error") {
            let presentAfter: boolean | null = null;
            try {
              const after = await readNativeAccountState(
                connection,
                candidate.pubkey
              );
              if (after.kind === "read") presentAfter = true;
              if (after.kind === "missing") presentAfter = false;
            } catch {
              // observation unavailable; stated as such
            }
            setRunState({
              status: "error",
              outcome: "on-chain-failure",
              accountPresentAfterAction: presentAfter,
              error:
                "The transaction was confirmed on-chain but failed. It changed nothing.",
            });
            return;
          }

          if (resolution.type === "account-gone") {
            setRunState({
              status: "done",
              outcome: "close-unattributed",
              accountPresentAfterAction: false,
              error:
                "The account is gone. Whether this app's transaction closed it could not be established.",
            });
            return;
          }

          if (resolution.type === "unresolved") {
            holdLockForDismissal = true;
            setRunState({
              status: "unverified",
              outcome: "unresolved-outcome",
              errorDetail: resolution.detail,
              error:
                "We could not verify whether the burn landed. The transaction's outcome could not be established. It may still land. Nothing more will be sent automatically.",
            });
            return;
          }

          // expired-standard-met: provable non-landing, corroborated.
          if (reSignUsed) {
            let observation: NativeAccountRead | null = null;
            try {
              const after = await readNativeAccountState(
                connection,
                candidate.pubkey
              );
              if (after.kind !== "unreadable") observation = after;
            } catch {
              // observation unavailable; stated as such
            }
            if (observation && observation.kind === "missing") {
              setRunState({
                status: "done",
                outcome: "close-unattributed",
                accountPresentAfterAction: false,
                error:
                  "The account is gone. Whether this app's transaction closed it could not be established.",
              });
              return;
            }
            setRunState({
              status: "error",
              outcome: "expired",
              accountPresentAfterAction:
                observation === null ? null : observation.kind === "read",
              error:
                observation === null
                  ? "The transaction expired again and was not retried further. The follow-up read failed, so the current state of the account is unknown."
                  : "The transaction expired again and was not retried further. When we checked, the account still existed.",
            });
            return;
          }
          reSignUsed = true;
          lastResolutionNote =
            "The transaction expired before the network confirmed it. Nothing landed. Retrying once with a fresh transaction. Your approval is required again.";
          // loop: fresh build + fresh explicit approval
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const friendly = err instanceof FriendlyError;
        setState((prev) => ({
          ...prev,
          status: "error",
          outcome: friendly ? err.outcome : "cancelled",
          note: null,
          error: friendly
            ? message
            : "The burn could not be prepared. Nothing was signed or sent.",
          errorDetail: friendly ? null : message,
        }));
      } finally {
        // The unresolved hold survives only while the dismissal card is
        // mounted. Past an unmount no card can ever be shown, so the
        // hold releases there instead of orphaning the mutex against
        // the remounted page.
        if (!holdLockForDismissal || unmountedRef.current) {
          releaseAction("burn");
          holdsLockRef.current = false;
        }
        burnInFlight.current = false;
      }
    },
    [connection, wallet]
  );

  const reset = useCallback(() => {
    if (statusRef.current === "unverified" && heldAction() === "burn") {
      releaseAction("burn");
      holdsLockRef.current = false;
    }
    setState(INITIAL_STATE);
  }, []);

  const actionInFlight =
    IN_FLIGHT_STATUSES.has(state.status) ||
    // The unresolved terminal holds the mutex until the user
    // dismisses it (§8.11); the affordance must say so too, or the
    // page would re-enable buttons that can only end in an
    // action-conflict error.
    (state.status === "unverified" &&
      state.outcome === "unresolved-outcome");

  return { ...state, actionInFlight, burn, reset };
}
