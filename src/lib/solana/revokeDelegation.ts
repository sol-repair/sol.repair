/**
 * Funded-account delegate revocation (G.2): pure eligibility, the
 * revoke-only instruction builder, the single-account on-chain read,
 * and the shared refresh-gate evaluator (spec §4, §7, §8.3).
 *
 * Import boundary (spec §9.5, test-enforced): this module imports
 * @solana/web3.js, createRevokeInstruction from @solana/spl-token, and
 * types + constants from ./tokenAccounts — nothing else. It must NOT
 * import closeAccounts, fees, walletInspection, explain, or postState:
 * the close flow's builder contract and the read-only inspection layer
 * stay unreachable from here, in both directions.
 *
 * Safety contract (spec §7.2): buildRevokeInstruction produces exactly
 * ONE instruction — the owning token program's Revoke (wire tag 0x05,
 * two keys: the token account writable, the owner as sole signer, no
 * third account, no amount field). It never decides WHETHER to build;
 * the hook calls it only after the refresh gate passes.
 *
 * Eligibility is derived only from machine-readable scan evidence
 * (SkippedAccount fields), never from `reason` prose (spec §4.1).
 */

import {
  type Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { createRevokeInstruction } from "@solana/spl-token";

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  nativeStatusOf,
  type NativeStatus,
  type ScanResult,
  type TokenProgram,
} from "./tokenAccounts";

const PROGRAM_IDS: Record<TokenProgram, PublicKey> = {
  spl: TOKEN_PROGRAM_ID,
  "token-2022": TOKEN_2022_PROGRAM_ID,
};

/** One actionable delegation derived from a completed scan (spec §4.2). */
export interface RevocableDelegation {
  /** The token account's public key, base58-encoded. */
  pubkey: string;
  mint: string;
  /** Scan-time validated balance in exact base units (balanceAtScan). */
  balanceAtScan: string;
  decimals: number;
  /** Lamports (rent) the account holds, from the scan. */
  lamports: number;
  /** Owning token program; selects the Revoke instruction's program. */
  program: TokenProgram;
  /** Base58 address of the reviewed delegate. */
  delegate: string;
}

/**
 * Select the scan's funded delegated accounts that satisfy every G.2
 * eligibility condition (spec §4.2):
 *   E1 cause "funded"            (the scan's positive-balance marker)
 *   E2 validated positive balance + lamports/decimals present
 *   E3 delegated, with the delegate's base58 address
 *   E4 not frozen                (on-chain Revoke rejects frozen)
 *   E5 nativeStatus === "non-native"  (confirmed non-native ONLY;
 *      confirmed-native and unknown are both ineligible)
 *   E6 owner + program           (guaranteed by scan construction)
 */
export function selectRevocableDelegations(
  scan: ScanResult
): RevocableDelegation[] {
  const out: RevocableDelegation[] = [];
  for (const entry of scan.skippedAccounts) {
    if (entry.cause !== "funded") continue;
    if (!entry.delegated || typeof entry.delegate !== "string") continue;
    if (entry.delegate === "") continue;
    if (entry.frozen === true) continue;
    if (entry.nativeStatus !== "non-native") continue;
    if (
      typeof entry.balance !== "string" ||
      !/^\d+$/.test(entry.balance) ||
      BigInt(entry.balance) <= 0n
    ) {
      continue;
    }
    if (
      typeof entry.lamports !== "number" ||
      !Number.isInteger(entry.lamports) ||
      entry.lamports < 0
    ) {
      continue;
    }
    if (typeof entry.decimals !== "number") continue;
    out.push({
      pubkey: entry.pubkey,
      mint: entry.mint,
      balanceAtScan: entry.balance,
      decimals: entry.decimals,
      lamports: entry.lamports,
      program: entry.program,
      delegate: entry.delegate,
    });
  }
  return out;
}

/**
 * Build THE revoke instruction for one delegation: one byte of data
 * (0x05), two keys (token account writable non-signer; owner the sole
 * signer), targeting the owning token program. Nothing else — no
 * close, no transfer, no fee instruction is ever produced here.
 */
export function buildRevokeInstruction(
  delegation: RevocableDelegation,
  owner: PublicKey
): TransactionInstruction {
  return createRevokeInstruction(
    new PublicKey(delegation.pubkey),
    owner,
    [],
    PROGRAM_IDS[delegation.program]
  );
}

/* ------------------------------------------------------------------ */
/* The single-account on-chain read (spec §8.3, §8.9)                  */
/* ------------------------------------------------------------------ */

/** Shape of the parsed JSON the RPC returns for token accounts. The
 *  scan validates the same shape deep-field by deep-field; this read
 *  re-applies that discipline (never defaults a malformed number). */
interface ParsedTokenAccountInfo {
  mint: string;
  owner: string;
  tokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
  /** Omitted by the parsed response when no delegate is set. */
  delegate?: string | null;
  state: string;
  /** Omitted by some providers; never coerced (spec §4.3). */
  isNative?: boolean;
}

function readParsedTokenInfo(data: unknown): ParsedTokenAccountInfo | null {
  if (typeof data !== "object" || data === null) return null;
  const parsed = (data as { parsed?: unknown }).parsed;
  if (typeof parsed !== "object" || parsed === null) return null;
  const info = (parsed as { info?: unknown }).info;
  return typeof info === "object" && info !== null
    ? (info as ParsedTokenAccountInfo)
    : null;
}

export type DelegatedAccountRead =
  | { kind: "unreadable" }
  | { kind: "missing" }
  | {
      kind: "read";
      /** Base58 delegate, or null when the account names none. */
      delegate: string | null;
      /** Validated balance in exact base units. */
      balance: string;
      decimals: number;
      frozen: boolean;
      nativeStatus: NativeStatus;
      /** The account's parsed wallet-owner, for the ownership check. */
      walletOwner: string;
    };

/**
 * Read ONE token account at "confirmed" — the commitment the
 * confirmation waits at, so a just-landed change is not hidden by
 * finalized lag (the verifyAccountsClosed discipline). Throws on RPC
 * failure; the caller decides how to report it.
 */
export async function readDelegatedAccountState(
  connection: Connection,
  pubkey: string
): Promise<DelegatedAccountRead> {
  const response = await connection.getParsedAccountInfo(
    new PublicKey(pubkey),
    "confirmed"
  );
  const account = response.value;
  if (!account) return { kind: "missing" };
  if (
    !account.owner.equals(TOKEN_PROGRAM_ID) &&
    !account.owner.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    return { kind: "unreadable" };
  }
  const info = readParsedTokenInfo(account.data);
  if (!info) return { kind: "unreadable" };
  if (
    typeof info.tokenAmount !== "object" ||
    info.tokenAmount === null ||
    typeof info.tokenAmount.amount !== "string" ||
    !/^\d+$/.test(info.tokenAmount.amount) ||
    typeof info.tokenAmount.decimals !== "number"
  ) {
    return { kind: "unreadable" };
  }
  if (info.state !== "initialized" && info.state !== "frozen") {
    return { kind: "unreadable" };
  }
  return {
    kind: "read",
    // The parsed response omits the delegate field when unset; an
    // empty string is no delegate either (the scan's Boolean()
    // discipline, spec §4.2 E3).
    delegate: info.delegate ? info.delegate : null,
    balance: info.tokenAmount.amount,
    decimals: info.tokenAmount.decimals,
    frozen: info.state === "frozen",
    nativeStatus: nativeStatusOf(info.isNative),
    walletOwner: info.owner,
  };
}

/* ------------------------------------------------------------------ */
/* The refresh-gate evaluator (spec §8.3)                              */
/* ------------------------------------------------------------------ */

export type GateAbortReason =
  | "missing"
  | "unreadable"
  | "foreign-owner"
  | "frozen"
  | "confirmed-native"
  | "delegate-changed";

export type GateVerdict =
  | { kind: "pass"; balanceBeforeAction: string; delegate: string }
  | { kind: "already-absent"; balanceBeforeAction: string }
  | { kind: "abort"; reason: GateAbortReason; currentDelegate?: string };

/**
 * Compare one on-chain read against the reviewed evidence (spec §8.3).
 * Shared by the hook (authoritative, in-lock) and the confirmation
 * card (presentation), so both can never disagree. Balance drift is
 * NOT an abort (review-confirmed Case B): the balance travels to the
 * card, the consent decision stays with the user.
 */
export function evaluateDelegationGate(
  read: DelegatedAccountRead,
  reviewedDelegate: string,
  connectedOwner: string
): GateVerdict {
  if (read.kind === "missing") return { kind: "abort", reason: "missing" };
  if (read.kind === "unreadable")
    return { kind: "abort", reason: "unreadable" };
  if (read.walletOwner !== connectedOwner)
    return { kind: "abort", reason: "foreign-owner" };
  if (read.frozen) return { kind: "abort", reason: "frozen" };
  // isNative cannot change after initialization; this is defense in
  // depth only (spec §8.3). An "unknown" status does not abort — the
  // scan established non-native eligibility; the read simply could
  // not re-confirm it.
  if (read.nativeStatus === "native")
    return { kind: "abort", reason: "confirmed-native" };
  if (read.delegate === null)
    return { kind: "already-absent", balanceBeforeAction: read.balance };
  if (read.delegate !== reviewedDelegate)
    return {
      kind: "abort",
      reason: "delegate-changed",
      currentDelegate: read.delegate,
    };
  return {
    kind: "pass",
    balanceBeforeAction: read.balance,
    delegate: read.delegate,
  };
}

/** User-facing sentences for gate outcomes (spec §8.3). Shared so the
 *  hook's error line and the card's abort note say the same thing. */
export const GATE_ABORT_COPY: Record<GateAbortReason, string> = {
  missing: "This account no longer exists. The scan is out of date.",
  unreadable:
    "The account could not be read, so its current state is unknown. Nothing was signed.",
  "foreign-owner":
    "This token account is no longer owned by the connected wallet. Nothing was signed.",
  frozen: "This account is now frozen; a frozen account cannot be revoked.",
  "confirmed-native":
    "This account is a wrapped-SOL account; wrapped-SOL accounts are not supported by delegate revocation.",
  "delegate-changed":
    "The delegate on this account is now a different address. The permission you reviewed is out of date.",
};

export function gateAbortSentence(verdict: GateVerdict & { kind: "abort" }) {
  if (verdict.reason === "delegate-changed" && verdict.currentDelegate) {
    return `The delegate on this account is now a different address (${verdict.currentDelegate}). The permission you reviewed is out of date. Rescan to see the current state.`;
  }
  return GATE_ABORT_COPY[verdict.reason];
}

/** The already-absent sentence (spec §8.9 row 1). */
export const ALREADY_REVOKED_COPY =
  "The delegate was already absent. Nothing was signed.";
