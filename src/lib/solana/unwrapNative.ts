/**
 * Wrapped-SOL unwrap + close (G.3): pure eligibility, the
 * close-(+revoke) instruction builder, the single-account on-chain
 * read, and the shared refresh-gate evaluator (spec §4.2, §7.2, §8.3).
 *
 * Import boundary (spec §9.1, §9.5, test-enforced): this module
 * imports @solana/web3.js, createCloseAccountInstruction +
 * createRevokeInstruction from @solana/spl-token, and types +
 * constants from ./tokenAccounts — nothing else. It must NOT import
 * closeAccounts, fees, walletInspection, explain, postState,
 * revokeDelegation, React, or the wallet adapter: the close flow's
 * builder contract, the fee system, and the read-only inspection
 * layer stay unreachable from here, in both directions.
 *
 * Safety contract (spec §7.2, §7.4): buildUnwrapInstruction produces
 * exactly ONE instruction — the owning token program's CloseAccount
 * (wire tag 0x09, three keys: token account writable; destination
 * WRITABLE = the connected owner, the only destination the close
 * names; authority = the owner as sole signer) — plus, only when the
 * candidate carries delegate evidence, the shipped close-flow pair:
 * the owner-signed Revoke (wire tag 0x05) IMMEDIATELY BEFORE the
 * close. There is no destination parameter by which any other
 * destination could be passed. It never decides WHETHER to build; the
 * hook calls it only after the refresh gate passes.
 *
 * Eligibility is derived only from machine-readable scan evidence
 * (SkippedAccount fields), never from `reason` prose (spec §4.1).
 * The central invariant (spec §7.4): the ONLY intentional balance
 * change is every lamport the native account holds returning to the
 * owner's wallet address.
 */

import {
  type Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createCloseAccountInstruction,
  createRevokeInstruction,
  NATIVE_MINT,
  NATIVE_MINT_2022,
} from "@solana/spl-token";

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

/** Each program's native mint (spec §4.2 E4; both VERIFIED shipped
 *  constants). A native account is initialized only with its owning
 *  program's native mint, so a mismatch means corrupted evidence. */
const NATIVE_MINTS: Record<TokenProgram, string> = {
  spl: NATIVE_MINT.toBase58(),
  "token-2022": NATIVE_MINT_2022.toBase58(),
};

/** One actionable wrapped-SOL account derived from a completed scan
 *  (spec §4.2, §9.1). Empty (wrapped-sol cause) and funded (funded
 *  cause) are two presentation cases of one mechanism (§4.3). */
export interface UnwrappableNativeAccount {
  /** The token account's public key, base58-encoded. */
  pubkey: string;
  mint: string;
  /** Owning token program; selects the instruction's programId. */
  program: TokenProgram;
  /** Total lamports the account holds — the exact amount CloseAccount
   *  moves to the destination (§4.4, §7.5). */
  lamports: number;
  /** Wrapped balance at scan, exact base units. "0" for an entry from
   *  the wrapped-sol skip site: zero BY DERIVATION (the scan's
   *  zero-balance check passed immediately before that site skipped),
   *  recorded as a derivation, never invented as a balance field
   *  (§4.2 E6). */
  amountAtScan: string;
  /** Token decimals, funded case only — the wrapped-sol skip site
   *  carries no decimals evidence (§5.2). */
  decimals?: number;
  /** Base58 address of a delegate in the scan evidence, when the scan
   *  named one. The gate read may add or replace this live (§7.6). */
  delegate?: string;
}

/**
 * Select the scan's wrapped-SOL accounts that satisfy every G.3
 * eligibility condition (spec §4.2):
 *   E1 cause "wrapped-sol" (empty by construction) or "funded" with a
 *      positive wrapped balance — the two presentation cases
 *   E2 nativeStatus === "native"   (confirmed native ONLY; "unknown"
 *      and "non-native" are both ineligible — G.2's E5 mirrored)
 *   E3 lamports present, an integer >= 0 (never defaulted)
 *   E4 mint equals the owning program's native mint
 *   E5 owner + program             (guaranteed by scan construction)
 *   E6 funded feed: balance/decimals validated; wrapped-sol feed:
 *      balance 0 by construction (recorded as the derivation)
 */
export function selectUnwrappableNativeAccounts(
  scan: ScanResult
): UnwrappableNativeAccount[] {
  const out: UnwrappableNativeAccount[] = [];
  for (const entry of scan.skippedAccounts) {
    if (entry.cause !== "wrapped-sol" && entry.cause !== "funded") continue;
    // E2: only a confirmed "native" is eligible. "unknown" (the omitted
    // isNative field the wrapped-sol site honestly records) and
    // "non-native" (the repair/revocation flows' territory) never pass.
    if (entry.nativeStatus !== "native") continue;
    // E3: evidence completeness. Without valid lamports the recovered
    // amount would be invented — the zero-defaulting ban.
    if (
      typeof entry.lamports !== "number" ||
      !Number.isInteger(entry.lamports) ||
      entry.lamports < 0
    ) {
      continue;
    }
    // E4: the native-mint cross-check, from an independent field.
    if (entry.mint !== NATIVE_MINTS[entry.program]) continue;

    if (entry.cause === "wrapped-sol") {
      // E6: the wrapped balance is 0 by construction — the scan's
      // check #1 (zero balance) passed immediately before check #4
      // skipped. The zero is a derivation from the check order, not a
      // recorded field.
      out.push({
        pubkey: entry.pubkey,
        mint: entry.mint,
        program: entry.program,
        lamports: entry.lamports,
        amountAtScan: "0",
      });
      continue;
    }

    // Funded feed: the wrapped balance must be positive and validated.
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
 * Build THE unwrap instruction(s) for one candidate (spec §7.2): one
 * CloseAccount — one byte of data (0x09), three keys (token account
 * writable non-signer; destination = the connected owner, writable;
 * authority = the owner, sole signer), targeting the owning token
 * program — plus, ONLY when the candidate carries delegate evidence,
 * the owner-signed Revoke immediately BEFORE the close (the shipped
 * close-flow pair, §7.6). Nothing else, ever: no transfer, no
 * approve, no burn, no SyncNative, no fee instruction, no
 * compute-budget instruction of the app's own. The destination is
 * hardwired to the owner: this function takes no destination argument.
 */
export function buildUnwrapInstruction(
  candidate: UnwrappableNativeAccount,
  owner: PublicKey
): TransactionInstruction[] {
  const programId = PROGRAM_IDS[candidate.program];
  const account = new PublicKey(candidate.pubkey);
  const close = createCloseAccountInstruction(
    account,
    owner,
    owner,
    [],
    programId
  );
  if (candidate.delegate) {
    return [createRevokeInstruction(account, owner, [], programId), close];
  }
  return [close];
}

/* ------------------------------------------------------------------ */
/* The single-account on-chain read (spec §8.3, §9.1)                  */
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
  /** Omitted by the parsed response when no close authority is set. */
  closeAuthority?: string | null;
  state: string;
  /** Omitted by some providers; never coerced (spec §4.2 E2). */
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

export type NativeAccountRead =
  | { kind: "unreadable" }
  | { kind: "missing" }
  | {
      kind: "read";
      /** Owning token program (the RPC envelope's owner field). */
      program: TokenProgram;
      /** The account's parsed wallet-owner, for the ownership check. */
      walletOwner: string;
      mint: string;
      state: "initialized" | "frozen";
      nativeStatus: NativeStatus;
      /** Validated wrapped balance in exact base units. */
      amount: string;
      decimals: number;
      /** Validated total lamports — what the close will move. */
      lamports: number;
      /** Base58 close authority, or null when none is set (the owner
       *  is then the close authority, Appendix A.3). */
      closeAuthority: string | null;
      /** Base58 delegate, or null when the account names none. */
      delegate: string | null;
    };

/**
 * Read ONE token account at "confirmed" — the commitment the
 * confirmation waits at, so a just-landed change is not hidden by
 * finalized lag (the verifyAccountsClosed discipline at single-account
 * scale, spec §2.2). Throws on RPC failure; the caller decides how to
 * report it.
 */
export async function readNativeAccountState(
  connection: Connection,
  pubkey: string
): Promise<NativeAccountRead> {
  const response = await connection.getParsedAccountInfo(
    new PublicKey(pubkey),
    "confirmed"
  );
  const account = response.value;
  if (!account) return { kind: "missing" };
  const program: TokenProgram | null = account.owner.equals(TOKEN_PROGRAM_ID)
    ? "spl"
    : account.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? "token-2022"
      : null;
  if (program === null) return { kind: "unreadable" };
  const info = readParsedTokenInfo(account.data);
  if (!info) return { kind: "unreadable" };
  if (
    typeof info.tokenAmount !== "object" ||
    info.tokenAmount === null ||
    typeof info.tokenAmount.amount !== "string" ||
    !/^\d+$/.test(info.tokenAmount.amount) ||
    typeof info.tokenAmount.decimals !== "number" ||
    typeof account.lamports !== "number" ||
    !Number.isInteger(account.lamports) ||
    account.lamports < 0
  ) {
    return { kind: "unreadable" };
  }
  if (info.state !== "initialized" && info.state !== "frozen") {
    return { kind: "unreadable" };
  }
  return {
    kind: "read",
    program,
    walletOwner: info.owner,
    mint: info.mint,
    state: info.state,
    nativeStatus: nativeStatusOf(info.isNative),
    amount: info.tokenAmount.amount,
    decimals: info.tokenAmount.decimals,
    lamports: account.lamports,
    // Both fields are omitted by the parsed response when unset; an
    // empty string is no authority either (the scan's Boolean()
    // discipline).
    closeAuthority: info.closeAuthority ? info.closeAuthority : null,
    delegate: info.delegate ? info.delegate : null,
  };
}

/* ------------------------------------------------------------------ */
/* The refresh-gate evaluator (spec §8.3)                              */
/* ------------------------------------------------------------------ */

export type NativeGateAbortReason =
  | "unreadable"
  | "foreign-owner"
  | "foreign-close-authority"
  | "impossible-frozen"
  | "native-status-lost"
  | "mint-mismatch";

export type NativeGateVerdict =
  | {
      kind: "pass";
      amountBeforeAction: string;
      lamportsBeforeAction: number;
      /** Live delegate evidence: the pair builder keys on this. */
      delegate: string | null;
    }
  | { kind: "already-closed" }
  | { kind: "abort"; reason: NativeGateAbortReason };

/**
 * Compare one on-chain read against the reviewed evidence (spec §8.3).
 * Shared by the hook (authoritative, in-lock) and the confirmation
 * card (presentation), so both can never disagree. Amount/lamports
 * drift is NOT an abort (review-confirmed Case B policy): the figures
 * travel to the card, the consent decision stays with the user. A
 * delegate present is NOT an abort either: the pair builder handles it
 * (§7.6) and the card names it.
 */
export function evaluateNativeGate(
  read: NativeAccountRead,
  reviewedMint: string,
  connectedOwner: string
): NativeGateVerdict {
  if (read.kind === "missing") return { kind: "already-closed" };
  if (read.kind === "unreadable")
    return { kind: "abort", reason: "unreadable" };
  if (read.walletOwner !== connectedOwner)
    return { kind: "abort", reason: "foreign-owner" };
  if (read.closeAuthority !== null && read.closeAuthority !== connectedOwner)
    return { kind: "abort", reason: "foreign-close-authority" };
  // A native account CANNOT be frozen (Appendix A.5). An observation
  // that cannot happen means the read cannot be trusted — never
  // treated as a thawable or closeable state.
  if (read.state === "frozen")
    return { kind: "abort", reason: "impossible-frozen" };
  // Defense in depth only (isNative cannot clear after initialization,
  // Appendix A.2). An "unknown" live status aborts too: the gate acts
  // only on confirmation — G.2's E5 mirrored.
  if (read.nativeStatus !== "native")
    return { kind: "abort", reason: "native-status-lost" };
  if (read.mint !== reviewedMint)
    return { kind: "abort", reason: "mint-mismatch" };
  return {
    kind: "pass",
    amountBeforeAction: read.amount,
    lamportsBeforeAction: read.lamports,
    delegate: read.delegate,
  };
}

/** User-facing sentences for gate outcomes (spec §8.3, §8.6). Shared
 *  so the hook's error line and the card's abort note say the same
 *  thing. */
export const NATIVE_GATE_ABORT_COPY: Record<NativeGateAbortReason, string> = {
  unreadable:
    "The current account state could not be read. Nothing was signed.",
  "foreign-owner":
    "This token account is no longer owned by the connected wallet. Nothing was signed.",
  "foreign-close-authority":
    "Another address holds the close authority on this account; only it can close the account now.",
  "impossible-frozen":
    "The fresh read reports this wrapped-SOL account as frozen, which wrapped-SOL accounts cannot be, so the read cannot be trusted. Nothing was signed.",
  "native-status-lost":
    "The fresh read could not confirm this account is a wrapped-SOL account. Nothing was signed.",
  "mint-mismatch":
    "The fresh read shows a different mint on this account than the scan recorded. Nothing was signed.",
};

/** The already-closed sentence (spec §8.9 row 1). */
export const ALREADY_CLOSED_COPY =
  "This account no longer exists — it may already have been closed. Nothing was signed.";
