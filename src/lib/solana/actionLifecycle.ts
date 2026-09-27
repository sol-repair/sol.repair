/**
 * The shared transaction-lifecycle machinery behind the four per-item
 * action hooks: useRevokeDelegate (G.2), useUnwrapNative (G.3),
 * useBurnDust, and useWithdrawExcess (G.4).
 *
 * What lives here is ONLY the evidence machinery the four hooks run
 * identically: the signature-status query with bounded in-place
 * retries, the block-height read, the corroboration skeleton (two
 * spaced status queries and two spaced account reads, all after the
 * window provably closed), the resolution loop built on them, and the
 * sign-stage refusal classification. Everything domain-specific stays
 * in the hooks: what a read means (delegate absent, native identity,
 * lamports continuity), which extra corroboration verdicts exist, how
 * verdicts map to terminal outcomes and copy, the gate, the builder,
 * the loop control itself, and the mutex ownership.
 *
 * The hooks inject two policies into the corroboration skeleton:
 *   - readOnce: one account read, reduced to read / missing / unusable.
 *     "unusable" covers both an RPC failure and a domain-unreadable
 *     shape - every hook reports the same sentence for both, so the
 *     distinction never mattered.
 *   - judge: whether one read is consistent with a transaction that
 *     never landed. A returned verdict terminalizes corroboration
 *     immediately (the asymmetric rule: one inconsistent observation
 *     blocks the re-sign); null continues. The second call receives
 *     the first read as `prior` for the continuity checks
 *     (lamports-identical, excess-identical).
 *
 * Resolution of a signed transaction is a LifecycleResolution<D>: the
 * four shared terminal shapes plus one domain passthrough for hooks
 * with corroboration verdicts of their own (revoke's
 * delegate-absent / delegate-changed). Hooks without domain verdicts
 * instantiate D = never and never see the passthrough.
 *
 * No React in this file. Nothing here signs or sends: the hooks hand
 * unsigned transactions to the wallet adapter and classify outcomes by
 * evidence, never by error-message shape - except at the sign stage,
 * where no signature exists and nothing can land.
 */

import type { Connection } from "@solana/web3.js";

/** Interval between resolution polls; also spaces the §8.5
 *  corroboration reads. */
export const RESOLVE_POLL_INTERVAL_MS = 1500;

/** Bounded in-place retries for transient RPC failures of a single
 *  status query (spec §8.5: reads are retried in place, never
 *  submissions). */
export const MAX_STATUS_RPC_ATTEMPTS = 3;

/** Consecutive fully-failed resolution rounds tolerated before the
 *  lifecycle stops and reports uncertainty (spec §8.4 S6). */
export const MAX_FAILED_ROUNDS = 3;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export type StatusOutcome =
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
export async function querySignatureStatus(
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

export async function readBlockHeight(
  connection: Connection
): Promise<number | null> {
  try {
    return await connection.getBlockHeight({ commitment: "confirmed" });
  } catch {
    return null;
  }
}

/** One corroboration account read, reduced to the three shapes the
 *  skeleton branches on. */
export type CorroborationRead<R> =
  | { kind: "read"; value: R }
  | { kind: "missing" }
  | { kind: "unusable" };

/**
 * What the §8.5 corroboration pass concluded about a past-the-window
 * transaction with no observed status. The four base verdicts are
 * shared by every flow; a hook may extend them with domain verdicts of
 * its own (revoke's delegate-absent / delegate-changed). A domain
 * member's `type` must not collide with the four base literals.
 */
export type CorroborationVerdict<D = never> =
  | { type: "standard-met" }
  | { type: "resolved"; err: unknown }
  | { type: "account-gone" }
  | { type: "cannot-establish"; detail: string }
  | D;

/** How resolving ONE signed transaction ended (spec §8.4 states): the
 *  shared terminal shapes, plus the domain passthrough carrying a
 *  hook's own corroboration verdict to its §8.9 mapping. */
export type LifecycleResolution<D = never> =
  | { type: "confirmed" }
  | { type: "on-chain-error" }
  | { type: "expired-standard-met" }
  | { type: "account-gone" }
  | { type: "unresolved"; detail: string }
  | { type: "domain"; verdict: D };

/**
 * The §8.5 non-landing evidence standard: two spaced status queries
 * both unobserved, and two spaced account reads judged consistent,
 * all AFTER the window provably closed. Called only in that state: a
 * spent blockhash proves the transaction cannot land in the FUTURE;
 * non-landing in the past requires the corroborated reads.
 *
 * Post-close evidence only (spec §8.5, verification fix): the
 * detecting iteration queried the status BEFORE reading the height,
 * so that query is not provably post-close and is NOT counted. The
 * standard's two spaced status queries start HERE, now that the
 * window is known to be closed - the first of them immediately, the
 * second one poll interval later.
 */
export async function corroborateNonLanding<R, D = never>(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  readOnce: () => Promise<CorroborationRead<R>>,
  judge: (read: R, prior: R | null) => CorroborationVerdict<D> | null
): Promise<CorroborationVerdict<D>> {
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
  const read1Result = await readOnce();
  if (read1Result.kind === "unusable") {
    return { type: "cannot-establish", detail: "the account read failed" };
  }
  if (read1Result.kind === "missing") {
    // The window is provably closed here: the honest terminal is
    // "the account is gone", never "it may still land" (§8.9).
    return { type: "account-gone" };
  }
  const read1 = read1Result.value;
  const firstVerdict = judge(read1, null);
  if (firstVerdict) return firstVerdict;

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

  // Second account read: must agree with the first - the judge sees
  // both reads for the continuity check.
  const read2Result = await readOnce();
  if (read2Result.kind === "unusable") {
    return { type: "cannot-establish", detail: "the account read failed" };
  }
  if (read2Result.kind === "missing") {
    return { type: "account-gone" };
  }
  const read2 = read2Result.value;
  const secondVerdict = judge(read2, read1);
  if (secondVerdict) return secondVerdict;

  // Every observation is consistent with a transaction that never
  // landed. Unanimous - the standard is met.
  return { type: "standard-met" };
}

/**
 * Resolve ONE signed, (possibly) submitted transaction to an §8.4
 * state, by evidence only (spec §8.5). The send step has already
 * happened - or failed - before this runs; a send error classifies
 * nothing. `corroborate` runs the §8.5 standard (typically
 * corroborateNonLanding with the hook's readOnce and judge); a send
 * error never triggers it - it only fires on an unobserved status
 * with the blockhash window provably closed.
 */
export async function resolveTransaction<D = never>(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  corroborate: () => Promise<CorroborationVerdict<D>>,
  setRunState: (patch: { status: "confirming"; note: string }) => void
): Promise<LifecycleResolution<D>> {
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
        const verdict = await corroborate();
        // The shared base four are discriminated by their literal
        // `type`; what remains of the union is the hook's D by
        // construction (its judge only returns base or domain
        // verdicts). A generic union cannot narrow on D, so the base
        // view is taken explicitly here and the leftover is carried
        // through as the domain passthrough.
        const base = verdict as CorroborationVerdict;
        if (base.type === "standard-met") {
          return { type: "expired-standard-met" };
        }
        if (base.type === "resolved") {
          return base.err !== null
            ? { type: "on-chain-error" }
            : { type: "confirmed" };
        }
        if (base.type === "account-gone") {
          return { type: "account-gone" };
        }
        if (base.type === "cannot-establish") {
          return { type: "unresolved", detail: base.detail };
        }
        return { type: "domain", verdict: verdict as D };
      }
      // status rpc-failed past the window: the standard cannot even
      // start, so this round is unresolvable - counted below.
    }

    // Window still open (or height unreadable): keep resolving. A
    // round that could not gather classifiable evidence - the status
    // stream down, or no status and no readable height - counts
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

/** A spent blockhash surfaces with several wordings: "Blockhash not
 *  found" when the RPC rejects the submission outright, "Signature
 *  ... has expired: block height exceeded." when the transaction dies
 *  while awaiting confirmation, and the wallets' "Transaction expired" /
 *  "TransactionExpiredBlockheightExceededError" refusals when their
 *  pre-prompt simulation outlived the window and they refuse to sign
 *  at all. All of them mean the same thing — the transaction is dead
 *  on arrival and the only fix is a fresh blockhash and a new
 *  signature. Used by classifySignRefusal at the sign stage.
 *  useRepairWallet keeps its own copy deliberately: the §10.7 guard
 *  freezes that hook's import surface, so the shape is duplicated
 *  exactly twice — here and there — and nowhere else. */
function isBlockhashExpiry(message: string): boolean {
  return /blockhash|block height|blockheight|expired/i.test(message);
}

/** The sign-stage refusal classes (spec §8.5): message shapes are used
 *  ONLY where no signature exists and nothing can land. A rejection is
 *  a cancelled nothing-sent action; an expiry-shaped refusal is
 *  retried once with a fresh transaction, since nothing was ever
 *  signed. Null means an unclassifiable raw error. */
export type SignRefusal = "rejected" | "expired-refusal";

export function classifySignRefusal(error: unknown): SignRefusal | null {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("rejected")) return "rejected";
  if (isBlockhashExpiry(message)) {
    return "expired-refusal";
  }
  return null;
}
