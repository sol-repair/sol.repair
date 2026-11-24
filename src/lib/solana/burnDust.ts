/**
 * Dust burn-and-close (docs/dust-zeroing-spec-draft.md, Revision 1).
 *
 * The third wallet action family after the repair (G.1) and the two
 * per-item actions (G.2 revoke, G.3 unwrap): for a FUNDED token account
 * the user explicitly chooses, one transaction burns the account's
 * entire token balance and then closes the account, returning
 * everything the account holds to the wallet. Burning is permanent and
 * SOL.REPAIR cannot judge what a token is worth; every sentence of copy
 * downstream of this module treats that as the consent load-bearing
 * wall (spec: findings, never verdicts).
 *
 * Mirrors unwrapNative.ts structurally on purpose: the same single-
 * account read discipline, the same gate shape shared by the hook
 * (authoritative, in-lock) and the confirmation card (presentation),
 * and the same builder rule that the preview can never drift from the
 * signed instruction objects.
 *
 * No React in this file.
 */

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  createBurnInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";

import { readNativeAccountState, type NativeAccountRead } from "./unwrapNative";
import { readMintBurnBlockers, type MintBurnRead } from "./t22MintBurnBlockers";
import { getFeeRecipient, isFeeEnabled } from "./fees";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type ScanResult,
  type TokenProgram,
} from "./tokenAccounts";

export { readNativeAccountState, readMintBurnBlockers };
export type { NativeAccountRead, MintBurnRead };

const PROGRAM_IDS: Record<TokenProgram, PublicKey> = {
  spl: TOKEN_PROGRAM_ID,
  "token-2022": TOKEN_2022_PROGRAM_ID,
};

/** One actionable dust account derived from a completed scan. Every
 *  field is scan evidence; nothing is derived beyond what the scan
 *  recorded (the zero-defaulting ban). */
export interface BurnableDustAccount {
  /** The token account's public key, base58-encoded. */
  pubkey: string;
  mint: string;
  /** Owning token program; selects both instructions' programId. */
  program: TokenProgram;
  /** All lamports the account holds at scan — what the close moves to
   *  the wallet, and the 1% fee's base by the Q1 ruling. */
  lamports: number;
  /** Token balance at scan, exact base units. */
  amountAtScan: string;
  /** Token decimals (the row and card display the unit story). */
  decimals: number;
  /** Base58 delegate in the scan evidence, when named. A delegate does
   *  not block an owner burn; the delegation ends with the close. */
  delegate?: string;
}

/**
 * Select the scan's funded accounts that satisfy every burn
 * eligibility condition (spec Revision 1, eligibility items 1-5):
 *   E1 funded (a positive balance — the point of the feature)
 *   E2 not frozen (the on-chain Burn rejects frozen accounts)
 *   E3 confirmed non-native ONLY ("unknown" never passes — the G.2 E5
 *      discipline; native belongs to the G.3 unwrap flow)
 *   E4 no foreign close authority (the trailing close would fail; the
 *      scan records this on the funded skip as evidence)
 *   E5 evidence completeness: lamports, balance, and decimals each
 *      validated — never defaulted, never invented
 */
export function selectBurnableDustAccounts(
  scan: ScanResult
): BurnableDustAccount[] {
  const out: BurnableDustAccount[] = [];
  for (const entry of scan.skippedAccounts) {
    if (entry.cause !== "funded") continue;
    if (entry.frozen === true) continue;
    if (entry.nativeStatus !== "non-native") continue;
    if (entry.foreignCloseAuthority === true) continue;
    if (
      typeof entry.lamports !== "number" ||
      !Number.isInteger(entry.lamports) ||
      entry.lamports < 0
    ) {
      continue;
    }
    if (
      typeof entry.balance !== "string" ||
      !/^\d+$/.test(entry.balance) ||
      BigInt(entry.balance) <= 0n
    ) {
      continue;
    }
    if (typeof entry.decimals !== "number") continue;
    const delegate =
      entry.delegated === true &&
      typeof entry.delegate === "string" &&
      entry.delegate !== ""
        ? entry.delegate
        : undefined;
    out.push({
      pubkey: entry.pubkey,
      mint: entry.mint,
      program: entry.program,
      lamports: entry.lamports,
      amountAtScan: entry.balance,
      decimals: entry.decimals,
      ...(delegate ? { delegate } : {}),
    });
  }
  return out;
}

/**
 * Build THE burn-and-close instruction pair for one reviewed candidate:
 * Burn (permanently destroys the account's whole current token balance)
 * then CloseAccount (returns every lamport the account holds to the
 * wallet). The burn amount is the GATE read's balance — the current
 * truth, not the scan's. The fee instruction is appended by the hook
 * (page-owned feeReady decision), exactly as the repair does; it is
 * never part of this builder. Nothing else, ever: no transfer, no
 * approve, no revoke, no compute-budget instruction of the app's own.
 */
export function buildBurnDustInstructions(
  candidate: BurnableDustAccount & { amountBeforeAction: string },
  owner: PublicKey
): TransactionInstruction[] {
  const programId = PROGRAM_IDS[candidate.program];
  const account = new PublicKey(candidate.pubkey);
  const mint = new PublicKey(candidate.mint);
  const amount = BigInt(candidate.amountBeforeAction);
  if (amount <= 0n) {
    throw new Error("the reviewed balance is zero; there is nothing to burn");
  }
  const burn = createBurnInstruction(
    account,
    mint,
    owner,
    amount,
    [],
    programId
  );
  const close = createCloseAccountInstruction(
    account,
    owner,
    owner,
    [],
    programId
  );
  return [burn, close];
}

/* ------------------------------------------------------------------ */
/* The batched burn-and-close (owner decision 2026-11-22, E424/E425).  */
/* Multiple reviewed accounts ride one transaction: k burn+close pairs  */
/* then ONE summed fee transfer riding LAST. N accounts cost           */
/* ceil(N / MAX_BURN_PAIRS_PER_TX) approvals instead of N.             */
/* ------------------------------------------------------------------ */

/**
 * Maximum burn+close pairs packed into one transaction, derived and
 * measured with the repo's own serializer (E425, probe receipt
 * .verify-tmp/batch-size-probe.mjs). A transaction is limited to 1232
 * bytes. Measured facts this cap is built on:
 *   fixed overhead (one 64-byte signature, message header, blockhash,
 *     count prefixes):                        247 bytes
 *   per burn+close pair (2 keys x 32 + burn ix 15 + close ix 7):
 *                                              86 bytes
 *   one extra program key when a chunk mixes SPL and Token-2022:
 *                                              32 bytes
 *   the measured wallet-appended worst (the E421 wire's 4 keyless
 *     instructions; the first costs 44 with its program key, the
 *     rest 12 each):                           80 bytes
 *   the stated margin floor (E425):            69 bytes
 * 1232 - (247 + 32 + 80 + 69) = 804; 804 / 86 = 9.35 -> 9 pairs.
 * The four measured cells at this cap are pinned in tests:
 * plain 1,021 (margin 211); mixed 1,053 (179); plain + append 1,101
 * (131); mixed + append 1,133 (99) - the worst measured shape clears
 * the 69-byte floor, so this cap holds uniformly and mixed chunks
 * need no lower cap. Beyond the raw maximum (k=11, 1,193) the
 * serializer itself refuses the transaction.
 */
export const MAX_BURN_PAIRS_PER_TX = 9;

/**
 * The batched fee arithmetic (owner decision 2026-11-22): the SUM of
 * each account's own floor(1%), NOT floor(1% of the sum). This is
 * byte-identical to what the same accounts cost burned one at a time,
 * which is the consent property the batch ships under. The published
 * fee-ledger rule accepts both exact readings of "1%, floored"; at
 * this batch size they differ by at most k-1 = 8 lamports per
 * transaction. fees.ts is frozen and untouched: this helper lives in
 * the dust flow's own builder and mirrors the frozen rate (FEE_PERCENT
 * = 1) exactly as the ledger's read-only mirror does.
 */
export function sumFloorFeeLamports(
  accounts: Array<{ lamports: number }>
): bigint {
  return accounts.reduce(
    (acc, a) => acc + (BigInt(a.lamports) * 1n) / 100n,
    0n
  );
}

/** One reviewed-and-gate-passed candidate for a batch: the current
 *  truth from the gate read travels with it (the same fields the
 *  single-account flow consents to). */
export type BatchedBurnCandidate = BurnableDustAccount & {
  amountBeforeAction: string;
  lamportsBeforeAction: number;
};

/**
 * Build ONE batched burn-and-close transaction for a chunk of reviewed
 * candidates: each account contributes its [burn, close] pair (the
 * same two instructions the single-account flow signs, the burn amount
 * the GATE read's balance), then ONE summed fee transfer riding LAST
 * carrying the chunk's sum of per-account floors. The fee rides only
 * when the page's feeReady decision says the fee account exists AND
 * the fee is enabled (the same guards the frozen buildFeeTransfer
 * applies), and the recipient comes from the frozen module. Nothing
 * else, ever: no transfer of the app's own beyond the disclosed fee,
 * no compute-budget instruction of the app's own.
 */
export function buildBatchedBurnDustInstructions(
  candidates: BatchedBurnCandidate[],
  owner: PublicKey,
  feeReady: boolean
): TransactionInstruction[] {
  if (candidates.length === 0) {
    throw new Error("a batched burn needs at least one reviewed account");
  }
  if (candidates.length > MAX_BURN_PAIRS_PER_TX) {
    throw new Error(
      `a batched burn carries at most ${MAX_BURN_PAIRS_PER_TX} accounts per transaction`
    );
  }
  const instructions: TransactionInstruction[] = [];
  for (const candidate of candidates) {
    const amount = BigInt(candidate.amountBeforeAction);
    if (amount <= 0n) {
      throw new Error(
        "a reviewed balance is zero; there is nothing to burn on " +
          candidate.pubkey
      );
    }
    instructions.push(
      ...buildBurnDustInstructions(candidate, owner)
    );
  }
  if (feeReady && isFeeEnabled()) {
    // The fee base is what each close RETURNS at gate time: the
    // candidate's lamportsBeforeAction, NEVER the scan's lamports
    // figure (the devnet rehearsal walk caught the drift: a
    // Token-2022 account born at extension-era rent 1,513,840 was
    // charged floor(1%) of the scan's 1,488,440 until the builder was
    // pinned to the gate figure; receipt walk-chunk-2, 2026-11-23).
    const lamports = sumFloorFeeLamports(
      candidates.map((c) => ({ lamports: c.lamportsBeforeAction }))
    );
    if (lamports > 0n) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: getFeeRecipient(),
          lamports,
        })
      );
    }
  }
  return instructions;
}

/* ------------------------------------------------------------------ */
/* The refresh-gate evaluator (mirrors unwrapNative's gate shape)      */
/* ------------------------------------------------------------------ */

export type BurnGateAbortReason =
  | "unreadable"
  | "foreign-owner"
  | "foreign-close-authority"
  | "frozen"
  | "native-status"
  | "mint-mismatch"
  // Token-2022 mint-side burn blockers (audit M2): the on-chain standard
  // Burn refuses these mints, so the gate aborts before anything is
  // signed. Classic mints cannot carry extensions and never see these.
  | "mint-paused"
  | "mint-permissioned"
  | "mint-confidential"
  | "mint-unreadable";

export type BurnGateVerdict =
  | {
      kind: "pass";
      balanceBeforeAction: string;
      lamportsBeforeAction: number;
      decimals: number;
      /** Live delegate evidence; does not block an owner burn. */
      delegate: string | null;
    }
  | { kind: "already-gone" }
  | { kind: "already-empty" }
  | { kind: "abort"; reason: BurnGateAbortReason };

/**
 * Compare one on-chain read against the reviewed evidence. Balance or
 * lamports drift vs the scan is NOT an abort (the review-confirmed
 * Case B policy shared with G.2/G.3): the current figures travel to
 * the card and the user consents to burn exactly what the fresh read
 * shows. A delegate present is NOT an abort: the owner can always burn
 * their own account's balance, and the delegation ends with the close.
 *
 * The optional mint read (audit M2) is ADDITIVE: every account-side
 * verdict below decides first, exactly as before, and the mint
 * blockers only convert a would-be pass into an abort. Undefined means
 * the candidate is classic-program (no mint extensions possible) and
 * the gate behaves bit-for-bit as before the mint check existed.
 */
export function evaluateBurnGate(
  read: NativeAccountRead,
  reviewedMint: string,
  connectedOwner: string,
  mintRead?: MintBurnRead
): BurnGateVerdict {
  if (read.kind === "missing") return { kind: "already-gone" };
  if (read.kind === "unreadable") return { kind: "abort", reason: "unreadable" };
  if (read.walletOwner !== connectedOwner)
    return { kind: "abort", reason: "foreign-owner" };
  if (read.closeAuthority !== null && read.closeAuthority !== connectedOwner)
    return { kind: "abort", reason: "foreign-close-authority" };
  if (read.state === "frozen") return { kind: "abort", reason: "frozen" };
  // Burn only a confirmed non-native: the unwrap flow owns native
  // accounts, and an "unknown" live status aborts (act only on
  // confirmation — the G.2 E5 discipline).
  if (read.nativeStatus !== "non-native")
    return { kind: "abort", reason: "native-status" };
  if (read.mint !== reviewedMint)
    return { kind: "abort", reason: "mint-mismatch" };
  if (BigInt(read.amount) === 0n) return { kind: "already-empty" };
  if (mintRead !== undefined) {
    if (mintRead.status === "unreadable") {
      return { kind: "abort", reason: "mint-unreadable" };
    }
    if (mintRead.status === "blocked") {
      return {
        kind: "abort",
        reason:
          mintRead.blocker === "paused"
            ? "mint-paused"
            : mintRead.blocker === "permissioned-burn"
              ? "mint-permissioned"
              : "mint-confidential",
      };
    }
  }
  return {
    kind: "pass",
    balanceBeforeAction: read.amount,
    lamportsBeforeAction: read.lamports,
    decimals: read.decimals,
    delegate: read.delegate,
  };
}

/** User-facing sentences for gate outcomes. Shared so the hook's error
 *  line and the card's abort note say the same thing. */
export const BURN_GATE_ABORT_COPY: Record<BurnGateAbortReason, string> = {
  unreadable:
    "The current account state could not be read. Nothing was signed.",
  "foreign-owner":
    "This token account is no longer owned by the connected wallet. Nothing was signed.",
  "foreign-close-authority":
    "Another address holds the close authority on this account; only it can close the account now. Nothing was signed.",
  frozen:
    "The fresh read reports this account as frozen, and a frozen account cannot be burned. Nothing was signed.",
  "native-status":
    "The fresh read reports this account as a wrapped-SOL account. Use the unwrap action for wrapped SOL. Nothing was signed.",
  "mint-mismatch":
    "The fresh read shows a different mint on this account than the scan recorded. Nothing was signed.",
  "mint-paused":
    "This mint is paused. Only its authority can unpause it. Nothing was signed.",
  "mint-permissioned":
    "This mint requires its own burn authority to approve any burn. SOL.REPAIR cannot burn it. Nothing was signed.",
  "mint-confidential":
    "This mint uses confidential burning, which this tool does not support. Nothing was signed.",
  "mint-unreadable":
    "The mint's extensions could not be read. Nothing was signed.",
};

/** Terminal sentences for the two non-abort gate specials. */
export const ALREADY_GONE_COPY =
  "This account no longer exists. It may already have been closed. Nothing was signed.";
export const ALREADY_EMPTY_COPY =
  "This account holds no tokens now. The repair flow on the home page closes empty accounts. Nothing was signed.";
