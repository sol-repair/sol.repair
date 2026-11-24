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
 *     the fee account exists (the Q1 ruling; the repair model).
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
import { buildTransaction, chunkInstructions } from "@/lib/solana/transactions";
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
  MAX_BURN_PAIRS_PER_TX,
  buildBatchedBurnDustInstructions,
  buildBurnDustInstructions,
  evaluateBurnGate,
  readMintBurnBlockers,
  readNativeAccountState,
  type BatchedBurnCandidate,
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
  | "burn-unverified-reads"
  | "already-gone"
  | "already-empty"
  | "close-unattributed"
  // error
  | "run-stopped"
  | "gate-state-changed"
  | "cancelled"
  | "expired"
  | "on-chain-failure"
  | "action-conflict"
  | "recreated-after-close"
  | "state-changed-since-review"
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
  /** Batched-run progress while awaiting approvals (the repair's
   *  N-of-M shape): 1-based current transaction and the chunk total.
   *  Null outside a batched run. */
  batchProgress: { current: number; total: number } | null;
  /** Every account pubkey in the current batched run, chunk order. */
  batchAccounts: string[] | null;
  /** Accounts verified gone so far in the batched run. */
  batchVerifiedCount: number;
  /** Accounts the batch gate excluded before anything was built, with
   *  the reason each dropped (the honest exclusion report). */
  batchExcluded: Array<{ pubkey: string; reason: string }> | null;
  /** Accounts included in confirmed transactions whose follow-up
   *  deletion reads could not be completed: closed on chain, never
   *  individually verified. Drives the split done card. */
  batchUnverifiedCount: number;
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
  batchProgress: null,
  batchAccounts: null,
  batchVerifiedCount: 0,
  batchExcluded: null,
  batchUnverifiedCount: 0,
};

/** The read shape the corroboration judge and the verification reads
 *  narrow to. */
type ReadAccount = Extract<NativeAccountRead, { kind: "read" }>;

/** The burn-specific corroboration verdict: the shared base already
 *  covers standard-met / resolved / account-gone / cannot-establish;
 *  this one carries the evidence that the account left the reviewed
 *  baseline (the gate's pre-send snapshot), which terminalizes
 *  corroboration into an honest stop. */
type BurnCorroboration =
  | {
      type: "state-changed-since-review";
      observedBalance: string;
      observedLamports: number;
    };

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
    async (
      candidate: BurnableDustAccount,
      feeReady: boolean,
      reviewed?: { balance?: string; lamports?: number }
    ) => {
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
        const mintRead =
          candidate.program === "token-2022"
            ? await readMintBurnBlockers(connection, candidate.mint)
            : undefined;
        const verdict: BurnGateVerdict = evaluateBurnGate(
          gateRead,
          candidate.mint,
          actionOwner.toBase58(),
          mintRead
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
        // Gate passed. Consent is with the REVIEWED figures: the
        // review card's figures travel in as `reviewed`, and when the
        // in-lock gate read differs from them, the flow stops before
        // anything is built or signed and requires a fresh review
        // click (the revised Case B policy: consent with reviewed
        // figures, not current figures). Callers that omit the
        // reviewed figures keep the drift-consent behavior.
        if (
          reviewed &&
          ((reviewed.balance !== undefined &&
            verdict.balanceBeforeAction !== reviewed.balance) ||
            (reviewed.lamports !== undefined &&
              verdict.lamportsBeforeAction !== reviewed.lamports))
        ) {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            error:
              "The account no longer matches what you reviewed. The fresh read shows " +
              `${verdict.balanceBeforeAction} base units and ` +
              `${verdict.lamportsBeforeAction} lamports. Nothing was signed. ` +
              "Start a fresh review to approve the current figures.",
          });
          return;
        }
        // Reviewed figures match (or none were passed). Balance and
        // lamports drift vs the scan is NOT an abort (Case B policy):
        // the figures travel to the card and the user consents with
        // current numbers. A delegate present is not an abort either:
        // the owner can always burn their own balance, and the
        // delegation ends with the close.
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
        // substitutions: EVERY read is judged against the gate's
        // pre-send snapshot (the reviewed baseline) — balance AND
        // lamports — so a figure that moved since the review blocks
        // the re-sign even when the reads agree with each other. The
        // token identity is judged on every read (confirmed
        // non-native, not frozen), and the lamports-identical
        // between-reads check stays as the second layer — one
        // inconsistent observation blocks the re-sign.
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
        ): CorroborationVerdict<BurnCorroboration> | null => {
          if (
            read.amount !== verdict.balanceBeforeAction ||
            read.lamports !== verdict.lamportsBeforeAction
          ) {
            return {
              type: "state-changed-since-review",
              observedBalance: read.amount,
              observedLamports: read.lamports,
            };
          }
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
          // The 1% fee rides AFTER the close, per the Q1
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

          const lastValidBlockHeight = unsigned.lastValidBlockHeight;
          let sendFailure: string | null = null;
          try {
            await connection.sendRawTransaction(signed.serialize());
          } catch (sendError) {
            // The error classifies nothing (the evidence loop asks the
            // chain), but the raw text is kept for the one terminal
            // that reports genuine uncertainty.
            sendFailure =
              sendError instanceof Error
                ? sendError.message
                : String(sendError);
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
                "The transaction was confirmed on-chain but failed. Nothing changed except the network fee, which was still charged." +
                (candidate.program === "token-2022"
                  ? " If this mint requires permissioned burning, is paused, or uses confidential burning, the burn can never succeed. Nothing was burned."
                  : ""),
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

          if (resolution.type === "domain") {
            // The corroboration reads left the reviewed baseline: the
            // window is provably closed, so nothing can land, and no
            // re-sign is attempted. The card reports the state as it
            // reads now and requires a fresh review.
            const changed = resolution.verdict;
            setRunState({
              status: "error",
              outcome: "state-changed-since-review",
              error:
                "The transaction expired without landing, and the account changed since you reviewed it. " +
                `When we checked, the balance was ${changed.observedBalance} base units and the account held ` +
                `${changed.observedLamports} lamports. Nothing more will be sent automatically. ` +
                "Start a fresh review to see the current state.",
            });
            return;
          }

          if (resolution.type === "unresolved") {
            holdLockForDismissal = true;
            setRunState({
              status: "unverified",
              outcome: "unresolved-outcome",
              errorDetail: sendFailure
                ? `${resolution.detail}; the submission itself failed with: ${sendFailure}`
                : resolution.detail,
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

  /**
   * The batched burn-and-close (owner decision 2026-11-22): N reviewed
   * accounts cost ceil(N / MAX_BURN_PAIRS_PER_TX) approvals instead of
   * N. Every candidate is gate-read in-lock BEFORE anything is chunked,
   * so one bad account can never strand a batch (it is excluded with a
   * stated reason instead). Each chunk is one all-or-nothing
   * transaction: k burn+close pairs plus one summed fee transfer riding
   * last (the sum of each account's own floor(1%), exactly what the
   * same accounts cost burned one at a time). A chunk that fails or is
   * cancelled STOPS the run: earlier chunks stand verified, the rest is
   * reported as not attempted. The consent shape mirrors the single
   * flow per account: reviewed figures must match the in-lock gate
   * read, or that account is excluded and the reason is stated.
   */
  const burnBatch = useCallback(
    async (
      candidates: BurnableDustAccount[],
      feeReady: boolean,
      reviewed?: Record<string, { balance?: string; lamports?: number }>
    ) => {
      if (burnInFlight.current) return;
      burnInFlight.current = true;

      let holdLockForDismissal = false;
      // Progress accounting for the progress-aware error terminal
      // (audit finding): declared outside the try so the catch can
      // report how much of the run stands when anything throws.
      let completedChunks = 0;
      let submittedCount = 0;
      let verifiedSoFar = 0;
      let totalChunks = 0;
      let totalAccounts = 0;
      const progressLine = () =>
        completedChunks > 0
          ? `${completedChunks} of ${totalChunks} transactions stand verified (${verifiedSoFar} of ${totalAccounts} accounts confirmed gone). `
          : submittedCount > 0
            ? `${submittedCount} transaction(s) were submitted but their outcome could not be established before the run stopped. `
            : "";
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

        // The single re-sign budget and the pacing note, per run (the
        // same variables the single-account loop owns there).
        let reSignUsed = false;
        let refusalRetryUsed = false;
        let lastResolutionNote: string | null = null;
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
          batchAccounts: candidates.map((c) => c.pubkey),
        });

        // ---- The batch gate: every candidate, in-lock, before chunking.
        const passing: Array<{
          candidate: BurnableDustAccount;
          verdict: Extract<BurnGateVerdict, { kind: "pass" }>;
        }> = [];
        const excluded: Array<{ pubkey: string; reason: string }> = [];
        for (const candidate of candidates) {
          let gateRead: NativeAccountRead;
          try {
            gateRead = await readNativeAccountState(connection, candidate.pubkey);
          } catch {
            excluded.push({
              pubkey: candidate.pubkey,
              reason: BURN_GATE_ABORT_COPY.unreadable,
            });
            continue;
          }
          const mintRead =
            candidate.program === "token-2022"
              ? await readMintBurnBlockers(connection, candidate.mint).catch(
                  () => undefined
                )
              : undefined;
          const verdict: BurnGateVerdict = evaluateBurnGate(
            gateRead,
            candidate.mint,
            actionOwner.toBase58(),
            mintRead
          );
          if (verdict.kind === "pass") {
            const want = reviewed?.[candidate.pubkey];
            if (
              want &&
              ((want.balance !== undefined &&
                verdict.balanceBeforeAction !== want.balance) ||
                (want.lamports !== undefined &&
                  verdict.lamportsBeforeAction !== want.lamports))
            ) {
              excluded.push({
                pubkey: candidate.pubkey,
                reason:
                  "The account no longer matches what you reviewed (fresh read: " +
                  `${verdict.balanceBeforeAction} base units, ` +
                  `${verdict.lamportsBeforeAction} lamports). Nothing was signed for it.`,
              });
              continue;
            }
            passing.push({ candidate, verdict });
            continue;
          }
          if (verdict.kind === "already-gone") {
            excluded.push({
              pubkey: candidate.pubkey,
              reason: ALREADY_GONE_COPY,
            });
            continue;
          }
          if (verdict.kind === "already-empty") {
            excluded.push({
              pubkey: candidate.pubkey,
              reason: ALREADY_EMPTY_COPY,
            });
            continue;
          }
          excluded.push({
            pubkey: candidate.pubkey,
            reason: BURN_GATE_ABORT_COPY[verdict.reason],
          });
        }

        if (passing.length === 0) {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            batchExcluded: excluded,
            error:
              "None of the selected accounts can be burned right now. Nothing was signed.",
          });
          return;
        }

        const chunks = chunkInstructions(
          passing,
          MAX_BURN_PAIRS_PER_TX
        ).map((group) =>
          group.map(
            ({ candidate, verdict }): BatchedBurnCandidate => ({
              ...candidate,
              amountBeforeAction: verdict.balanceBeforeAction,
              lamportsBeforeAction: verdict.lamportsBeforeAction,
            })
          )
        );
        totalChunks = chunks.length;
        totalAccounts = passing.length;

        setRunState({
          batchProgress: { current: 1, total: chunks.length },
          batchAccounts: passing.map(({ candidate }) => candidate.pubkey),
          batchExcluded: excluded,
        });

        // ---- The chunk loop: one approval per chunk.
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunk = chunks[chunkIndex];
          const chunkNote =
            chunkIndex > 0
              ? null
              : excluded.length > 0
                ? `${excluded.length} of the selected ${candidates.length} accounts were excluded before signing (the reasons are listed below).`
                : null;
          setRunState({
            status: "building",
            batchProgress: { current: chunkIndex + 1, total: chunks.length },
            note: chunkNote ?? lastResolutionNote,
          });

          const liveBeforeBuild = livePublicKeyRef.current;
          if (!liveBeforeBuild || !liveBeforeBuild.equals(actionOwner)) {
            throw new FriendlyError(
              `${progressLine()}The connected wallet changed. Stopped before signing anything. Nothing more will be sent.`
            );
          }

          const instructions = buildBatchedBurnDustInstructions(
            chunk,
            actionOwner,
            feeReady
          );
          const unsigned = await buildTransaction(
            connection,
            actionOwner,
            instructions
          );

          const liveBeforeSign = livePublicKeyRef.current;
          if (!liveBeforeSign || !liveBeforeSign.equals(actionOwner)) {
            throw new FriendlyError(
              `${progressLine()}The connected wallet changed. Stopped before signing anything. Nothing more will be sent.`
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
                chunks.length > 1
                  ? `Transaction ${chunkIndex + 1} of ${chunks.length} was cancelled. Earlier transactions stand. Nothing more will be sent.`
                  : "Transaction cancelled. Nothing was sent."
              );
            }
            if (refusal === "expired-refusal") {
              if (!refusalRetryUsed) {
                refusalRetryUsed = true;
                lastResolutionNote =
                  "The wallet refused the request: the transaction had expired. Nothing was signed. Retrying once with a fresh transaction.";
                chunkIndex -= 1; // rebuild the same chunk
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
              `${progressLine()}Wallet returned a transaction without a signature. Nothing was sent.`
            );
          }
          const signature = bs58.encode(signatureBytes);
          setRunState((prev) => ({
            status: "sending",
            signatures: [...prev.signatures, signature],
            note: null,
          }));

          const lastValidBlockHeight = unsigned.lastValidBlockHeight;
          let sendFailure: string | null = null;
          try {
            await connection.sendRawTransaction(signed.serialize());
            submittedCount += 1;
          } catch (sendError) {
            sendFailure =
              sendError instanceof Error
                ? sendError.message
                : String(sendError);
          }

          setRunState({ status: "confirming" });
          // The chunk's first account is the corroboration canary: the
          // §8.5 judge compares every read against the gate's pre-send
          // snapshot of that account (balance AND lamports), exactly
          // like the single flow. Per-account verification below covers
          // the whole chunk after confirmation.
          const canary = chunk[0];
          const readOnce = async (): Promise<
            CorroborationRead<ReadAccount>
          > => {
            try {
              const read = await readNativeAccountState(
                connection,
                canary.pubkey
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
          ): CorroborationVerdict<BurnCorroboration> | null => {
            if (
              read.amount !== canary.amountBeforeAction ||
              read.lamports !== canary.lamportsBeforeAction
            ) {
              return {
                type: "state-changed-since-review",
                observedBalance: read.amount,
                observedLamports: read.lamports,
              };
            }
            if (
              read.nativeStatus !== "non-native" ||
              read.state === "frozen"
            ) {
              return {
                type: "cannot-establish",
                detail:
                  "the account read could not confirm the token identity",
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
            // ---- Independent per-account verification.
            setRunState({ status: "verifying" });
            await sleep(RESOLVE_POLL_INTERVAL_MS);
            let chunkVerified = 0;
            let unavailable = 0;
            for (const account of chunk) {
              const tryRead = async (): Promise<NativeAccountRead> => {
                try {
                  return await readNativeAccountState(
                    connection,
                    account.pubkey
                  );
                } catch {
                  return { kind: "unreadable" };
                }
              };
              const first = await tryRead();
              if (first.kind === "missing") {
                chunkVerified += 1;
                continue;
              }
              await sleep(RESOLVE_POLL_INTERVAL_MS);
              const second = await tryRead();
              if (second.kind === "missing") {
                chunkVerified += 1;
                continue;
              }
              if (second.kind === "read") {
                setRunState((prev) => ({
                  accountPresentAfterAction: true,
                  status: "error",
                  outcome: "recreated-after-close",
                  batchVerifiedCount: prev.batchVerifiedCount + chunkVerified,
                  error:
                    "The transaction was confirmed by the network, but a fresh read shows an account still present: " +
                    `${account.pubkey}. SOL.REPAIR cannot tell what created it. Nothing more will be sent automatically.`,
                }));
                return;
              }
              unavailable += 1;
            }
            setRunState((prev) => ({
              status: "building",
              batchVerifiedCount: prev.batchVerifiedCount + chunkVerified,
              batchUnverifiedCount: prev.batchUnverifiedCount + unavailable,
              note:
                unavailable > 0
                  ? `Transaction ${chunkIndex + 1} of ${chunks.length} confirmed, but ${unavailable} follow-up read(s) failed, so those accounts are unverified.`
                  : `Transaction ${chunkIndex + 1} of ${chunks.length} verified.`,
            }));
            completedChunks += 1;
            verifiedSoFar += chunkVerified;
            continue; // next chunk
          }

          if (resolution.type === "on-chain-error") {
            setRunState({
              status: "error",
              outcome: "on-chain-failure",
              error:
                `Transaction ${chunkIndex + 1} of ${chunks.length} was confirmed on-chain but failed. Nothing in it changed except the network fee, which was still charged. ` +
                (chunks.length > 1
                  ? "Earlier transactions stand. Nothing more will be sent."
                  : ""),
            });
            return;
          }

          if (resolution.type === "account-gone") {
            // The chunk's canary is gone; whether this app's transaction
            // closed it could not be established. The run stops here.
            setRunState({
              status: "done",
              outcome: "close-unattributed",
              error:
                `${progressLine()}The account is gone. Whether this app's transaction closed it could not be established.`,
            });
            return;
          }

          if (resolution.type === "domain") {
            const changed = resolution.verdict;
            setRunState({
              status: "error",
              outcome: "state-changed-since-review",
              error:
                `${progressLine()}The transaction expired without landing, and the account changed since you reviewed it. ` +
                `When we checked, the balance was ${changed.observedBalance} base units and the account held ` +
                `${changed.observedLamports} lamports. Nothing more will be sent automatically. ` +
                "Start a fresh review to see the current state.",
            });
            return;
          }

          if (resolution.type === "unresolved") {
            holdLockForDismissal = true;
            setRunState({
              status: "unverified",
              outcome: "unresolved-outcome",
              errorDetail: sendFailure
                ? `${resolution.detail}; the submission itself failed with: ${sendFailure}`
                : resolution.detail,
              error:
                `${progressLine()}We could not verify whether the transaction landed. Its outcome could not be established. It may still land. Nothing more will be sent automatically.`,
            });
            return;
          }

          // expired-standard-met: provable non-landing, corroborated.
          if (reSignUsed) {
            setRunState({
              status: "error",
              outcome: "expired",
              error:
                "The transaction expired again and was not retried further. Nothing landed in it. Earlier transactions stand.",
            });
            return;
          }
          reSignUsed = true;
          lastResolutionNote =
            "The transaction expired before the network confirmed it. Nothing landed. Retrying once with a fresh transaction. Your approval is required again.";
          chunkIndex -= 1; // rebuild the same chunk
        }

        // Every chunk landed and verified (or the loop returned a
        // terminal above). A run whose follow-up reads could not
        // complete for some accounts ends on the distinct
        // unverified-reads outcome: the closures are confirmed on
        // chain, the individual fresh-read confirmation is not.
        setRunState((prev) =>
          prev.batchUnverifiedCount > 0
            ? { status: "done", outcome: "burn-unverified-reads" }
            : { status: "done", outcome: "burn-verified", note: null }
        );
      } catch (err) {
        // Progress-aware terminal (audit finding): a batch error must
        // account for the chunks that already stand, and unexpected
        // errors get their own outcome, never "cancelled".
        const message = err instanceof Error ? err.message : String(err);
        const friendly = err instanceof FriendlyError;
        const upgraded = completedChunks > 0 || submittedCount > 0;
        const progress = progressLine();
        if (friendly) {
          setState((prev) => ({
            ...prev,
            status: "error",
            outcome: upgraded ? "run-stopped" : err.outcome,
            error: `${upgraded ? progress : ""}${message}`,
            errorDetail: null,
          }));
        } else {
          const prepared = completedChunks === 0 && submittedCount === 0;
          setState((prev) => ({
            ...prev,
            status: "error",
            outcome: "run-stopped",
            error: prepared
              ? "The burn could not be prepared. Nothing was signed or sent."
              : `${progress}The run stopped unexpectedly at transaction ${completedChunks + 1} of ${totalChunks}. Nothing more will be sent.`,
            errorDetail: message,
          }));
        }
      } finally {
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

  return { ...state, actionInFlight, burn, burnBatch, reset };
}
