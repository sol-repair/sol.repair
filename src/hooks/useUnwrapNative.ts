"use client";

/**
 * useUnwrapNative: React hook that builds, submits, and verifies the
 * G.3 wrapped-SOL unwrap+close transaction for ONE native token
 * account (spec §8).
 *
 * Lifecycle: gate → build → sign → send → resolve → verify, with the
 * ten §8.9 terminal outcomes: already-closed (nothing signed),
 * unwrap-verified (confirmed + account-gone read), close-unattributed
 * (account gone, causation unproven), gate-state-changed, cancelled /
 * expired, on-chain-failure, action-conflict, unresolved-outcome, and
 * confirmed-verification-unavailable — never folded into each other.
 *
 * What this hook deliberately does NOT copy from useRepairWallet
 * (spec §8.5): classification by error-message shape. Every
 * post-signature outcome is classified by EVIDENCE — signature-status
 * queries, blockhash-height readings, and account reads — and the
 * single re-sign is permitted only when the §8.5 non-landing evidence
 * standard is met: two spaced null status queries and two spaced
 * account reads, all after the window provably closed, with the
 * account still present, token-owned, confirmed native, and
 * lamports-identical across the two reads (the lamports-identical
 * requirement guards the closed-then-recreated edge, §8.5). One
 * inconsistent observation blocks the re-sign (the asymmetric rule).
 * Message shapes are used in exactly one place: classifying a
 * sign-stage refusal, where no signature exists and nothing can land.
 * An RPC timeout never triggers a submission.
 *
 * Mutual exclusion (spec §8.11): the module-scoped lock shared by all
 * three action hooks is acquired synchronously before the first
 * await. The lock is released in `finally` at provably safe terminals
 * — and held past `unverified / unresolved-outcome` (a transaction
 * that may still land) until the user explicitly dismisses it via
 * reset(). Release is never timer-based.
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
  ALREADY_CLOSED_COPY,
  buildUnwrapInstruction,
  evaluateNativeGate,
  NATIVE_GATE_ABORT_COPY,
  readNativeAccountState,
  type NativeAccountRead,
  type UnwrappableNativeAccount,
} from "@/lib/solana/unwrapNative";
import { buildTransaction } from "@/lib/solana/transactions";

export type UnwrapStatus =
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

/** The ten §8.9 terminal outcomes (plus the one documented edge of
 *  row 4: a confirmed close whose verification read finds an account
 *  back at the address — the closed-then-recreated case §8.5 names;
 *  reported honestly, credited to nobody, mirroring the G.2 hook's
 *  shipped delegate-reapproved-after edge). */
export type UnwrapOutcome =
  // done
  | "already-closed"
  | "unwrap-verified"
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

export interface UnwrapState {
  status: UnwrapStatus;
  outcome: UnwrapOutcome | null;
  /** All submitted signatures, oldest first (dead ones included:
   *  they are explorable receipts). */
  signatures: string[];
  accountPubkey: string | null;
  amountAtScan: string | null;
  lamportsAtScan: number | null;
  amountBeforeAction: string | null;
  lamportsBeforeAction: number | null;
  /** The §8.9 verification read: true (still present), false (gone),
   *  null (the read never succeeded). */
  accountPresentAfterAction: boolean | null;
  /** Whether a delegate was on the account at the gate read. */
  delegatePresent: boolean | null;
  /** Attempt-stage message (e.g. the fresh-transaction retry note). */
  note: string | null;
  error: string | null;
  errorDetail: string | null;
}

const INITIAL_STATE: UnwrapState = {
  status: "idle",
  outcome: null,
  signatures: [],
  accountPubkey: null,
  amountAtScan: null,
  lamportsAtScan: null,
  amountBeforeAction: null,
  lamportsBeforeAction: null,
  accountPresentAfterAction: null,
  delegatePresent: null,
  note: null,
  error: null,
  errorDetail: null,
};

/** An error whose message is ALREADY user-facing copy (house pattern).
 *  Carries the terminal outcome it maps to, so the catch cannot
 *  overwrite an expired-refusal report with a cancelled one. */
class FriendlyError extends Error {
  outcome: UnwrapOutcome;
  constructor(message: string, outcome: UnwrapOutcome = "cancelled") {
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
type ReadAccount = Extract<NativeAccountRead, { kind: "read" }>;
type Corroboration =
  | { type: "standard-met" }
  | { type: "resolved"; err: unknown }
  | { type: "account-gone" }
  | { type: "cannot-establish"; detail: string };

/**
 * The §8.5 non-landing evidence standard, with native substitutions.
 * Called only when a status query came back unobserved AND the block
 * height is already beyond the transaction's window: a spent blockhash
 * proves the transaction cannot land in the FUTURE; non-landing in the
 * past requires corroborated reads — two spaced status queries both
 * unobserved, and two spaced account reads both showing the account
 * present, token-owned, confirmed native, and lamports-identical. ONE
 * inconsistent observation blocks the re-sign (the asymmetric rule):
 * evidence of an outcome always wins.
 *
 * The lamports-identical requirement is deliberate conservatism for
 * the re-sign standard (spec §8.5, Revision 2 F3): in the ordinary
 * case a landed close DELETES the account, so account-present by
 * itself already establishes non-landing. It guards the exotic edge
 * where the account at this address was closed and then RECREATED
 * before the corroboration reads — possible at a deterministic ATA
 * address without the owner's key — and indistinguishable from a
 * never-landed original precisely when the original held
 * approximately a fresh rent reserve. Any lamports drift between the
 * two reads is evidence the account's continuity is not established,
 * and routes to S6: the flow never re-signs against an account it
 * cannot vouch for.
 */
async function corroborateNonLanding(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  candidate: UnwrappableNativeAccount
): Promise<Corroboration> {
  const readOnce = async (): Promise<
    NativeAccountRead | { kind: "rpc-failed" }
  > => {
    try {
      return await readNativeAccountState(connection, candidate.pubkey);
    } catch {
      return { kind: "rpc-failed" };
    }
  };

  /** The account-identity half of the standard for ONE read: present,
   *  token-owned (the read's own discipline), confirmed native, and
   *  not a frozen (impossible) observation. */
  const identityEstablished = (read: ReadAccount): boolean =>
    read.nativeStatus === "native" && read.state !== "frozen";

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
    // "the account is gone", never "it may still land" (§8.9 row 7).
    return { type: "account-gone" };
  }
  if (!identityEstablished(read1)) {
    return {
      type: "cannot-establish",
      detail: "the account read could not confirm the native identity",
    };
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

  // Second account read: must agree with the first — presence, native
  // identity, AND the lamports figure.
  const read2 = await readOnce();
  if (read2.kind === "rpc-failed" || read2.kind === "unreadable") {
    return { type: "cannot-establish", detail: "the account read failed" };
  }
  if (read2.kind === "missing") {
    return { type: "account-gone" };
  }
  if (!identityEstablished(read2)) {
    return {
      type: "cannot-establish",
      detail: "the account read could not confirm the native identity",
    };
  }
  if (read2.lamports !== read1.lamports) {
    return {
      type: "cannot-establish",
      detail:
        "the account's lamports changed between the two corroboration reads, so its continuity is not established",
    };
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
  candidate: UnwrappableNativeAccount,
  setRunState: (patch: Partial<UnwrapState>) => void
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
          candidate
        );
        switch (verdict.type) {
          case "standard-met":
            return { type: "expired-standard-met" };
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

/** The in-flight statuses for the cross-action affordance (§8.11). */
const IN_FLIGHT_STATUSES: ReadonlySet<UnwrapStatus> = new Set([
  "checking-current-state",
  "building",
  "awaiting-signature",
  "sending",
  "confirming",
  "verifying",
]);

export function useUnwrapNative() {
  const connection = useRpcConnection();
  const wallet = useWallet();

  const [state, setState] = useState<UnwrapState>(INITIAL_STATE);

  // Synchronous in-flight flag (house pattern): a second unwrap()
  // while one runs is a no-op, and the guard is released in `finally`
  // even on failure.
  const unwrapInFlight = useRef(false);

  // Live public key mirrored through a ref so an in-flight action can
  // detect a wallet switch (the repair hook's B1 pattern).
  const livePublicKeyRef = useRef(wallet.publicKey);
  useEffect(() => {
    livePublicKeyRef.current = wallet.publicKey;
  }, [wallet.publicKey]);

  // Current status readable from reset() — the dismissal path that is
  // allowed to release the unresolved-outcome hold (§8.11 rule).
  const statusRef = useRef<UnwrapStatus>("idle");
  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  const unwrap = useCallback(
    async (candidate: UnwrappableNativeAccount) => {
      if (unwrapInFlight.current) return;
      unwrapInFlight.current = true;

      // The one unresolved terminal keeps the lock until the user
      // dismisses it (§8.11); every other terminal releases in the
      // finally below.
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
        // Synchronous cross-action mutex (spec §8.11). The local ref
        // guard above already no-ops same-hook re-entry; this acquire
        // is only reachable when another flow holds the lock.
        if (!acquireAction("unwrap")) {
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
            | Partial<UnwrapState>
            | ((prev: UnwrapState) => Partial<UnwrapState>)
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
          amountAtScan: candidate.amountAtScan,
          lamportsAtScan: candidate.lamports,
        });

        // ---- Step 2: the refresh gate (spec §8.3) ----
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
        const verdict = evaluateNativeGate(
          gateRead,
          candidate.mint,
          actionOwner.toBase58()
        );
        if (verdict.kind === "abort") {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            error: NATIVE_GATE_ABORT_COPY[verdict.reason],
          });
          return;
        }
        if (verdict.kind === "already-closed") {
          setRunState({
            status: "done",
            outcome: "already-closed",
            accountPresentAfterAction: false,
            error: ALREADY_CLOSED_COPY,
          });
          return;
        }
        // Gate passed. Amount/lamports drift vs the scan is NOT an
        // abort (review-confirmed Case B policy): both figures travel
        // to the card and the user consents with current numbers. A
        // live delegate is NOT an abort either (§7.6): the pair
        // builder handles it and the card names it — the live read
        // replaces any stale scan evidence.
        const buildCandidate: UnwrappableNativeAccount = { ...candidate };
        if (verdict.delegate) {
          buildCandidate.delegate = verdict.delegate;
        } else {
          delete buildCandidate.delegate;
        }
        setRunState({
          amountBeforeAction: verdict.amountBeforeAction,
          lamportsBeforeAction: verdict.lamportsBeforeAction,
          delegatePresent: verdict.delegate !== null,
        });

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
          const instructions = buildUnwrapInstruction(
            buildCandidate,
            actionOwner
          );
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
            buildCandidate,
            setRunState
          );

          if (resolution.type === "confirmed") {
            // ---- Step 9: independent verification (spec §8.9 row 4) ----
            setRunState({ status: "verifying" });
            // Settle: one poll interval lets the confirmed-commitment
            // view pass the landing slot before the account's
            // existence is judged (a processed-only status can land
            // here).
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
                outcome: "unwrap-verified",
              });
              return;
            }
            // One spaced corroborating read before any scary terminal
            // (the G.2 §8.9 row-4 note): a single lagging read must
            // not produce one.
            await sleep(RESOLVE_POLL_INTERVAL_MS);
            const secondRead = await tryVerificationRead();
            if (secondRead.kind === "missing") {
              setRunState({
                accountPresentAfterAction: false,
                status: "done",
                outcome: "unwrap-verified",
              });
              return;
            }
            if (secondRead.kind === "read") {
              // Confirmed close, yet an account sits at the address:
              // the closed-then-recreated edge §8.5 names. Observed
              // and reported without naming any actor (the §6.3
              // attribution ban). Never worded as this app's failure
              // or success.
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
                "The transaction was confirmed by the network, but the follow-up read failed, so the account's closure is unverified.",
            });
            return;
          }

          if (resolution.type === "on-chain-error") {
            // Atomic revert: the transaction changed nothing. Report
            // the failure separately from any account observation
            // (spec §8.9 row 6).
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
            // The account is gone and no confirmed signature status
            // exists for THIS signature: the state is good, causation
            // is not claimed (spec §8.9 row 7).
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
            // The ONE terminal that may still be in flight: hold the
            // lock until the user explicitly dismisses (§8.11).
            holdLockForDismissal = true;
            setRunState({
              status: "unverified",
              outcome: "unresolved-outcome",
              errorDetail: resolution.detail,
              error:
                "We could not verify whether the close landed. The transaction's outcome could not be established. It may still land. Nothing more will be sent automatically.",
            });
            return;
          }

          // expired-standard-met: provable non-landing, corroborated.
          if (reSignUsed) {
            // Second expiry: stop, with the account observation
            // (spec §8.9 row 8 — or row 7 if the observation shows
            // the account already gone).
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
            : "The unwrap could not be prepared. Nothing was signed or sent.",
          errorDetail: friendly ? null : message,
        }));
      } finally {
        if (!holdLockForDismissal) {
          releaseAction("unwrap");
        }
        unwrapInFlight.current = false;
      }
    },
    [connection, wallet]
  );

  const reset = useCallback(() => {
    // Dismissing the unresolved-outcome card is the ONE user event
    // that releases the held lock (§8.11). Any other reset leaves the
    // lock alone — a mid-flight reset is a UI misuse the in-flight
    // guard already prevents.
    if (statusRef.current === "unverified" && heldAction() === "unwrap") {
      releaseAction("unwrap");
    }
    setState(INITIAL_STATE);
  }, []);

  const actionInFlight =
    IN_FLIGHT_STATUSES.has(state.status) ||
    (state.status === "unverified" && state.outcome === "unresolved-outcome");

  return {
    ...state,
    actionInFlight,
    unwrap,
    reset,
  };
}
