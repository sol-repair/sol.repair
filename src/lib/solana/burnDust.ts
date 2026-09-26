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

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  createBurnInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";

import { readNativeAccountState, type NativeAccountRead } from "./unwrapNative";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type ScanResult,
  type TokenProgram,
} from "./tokenAccounts";

export { readNativeAccountState };
export type { NativeAccountRead };

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
   *  the wallet, and the 1% fee's base by the owner's Q1 ruling. */
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
/* The refresh-gate evaluator (mirrors unwrapNative's gate shape)      */
/* ------------------------------------------------------------------ */

export type BurnGateAbortReason =
  | "unreadable"
  | "foreign-owner"
  | "foreign-close-authority"
  | "frozen"
  | "native-status"
  | "mint-mismatch";

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
 */
export function evaluateBurnGate(
  read: NativeAccountRead,
  reviewedMint: string,
  connectedOwner: string
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
};

/** Terminal sentences for the two non-abort gate specials. */
export const ALREADY_GONE_COPY =
  "This account no longer exists. It may already have been closed. Nothing was signed.";
export const ALREADY_EMPTY_COPY =
  "This account holds no tokens now. The repair flow on the home page closes empty accounts. Nothing was signed.";
