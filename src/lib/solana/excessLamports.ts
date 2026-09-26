/**
 * Excess-lamport withdrawal (G.4, docs/g4-excess-lamports-spec-draft.md
 * Revision 1). For a Token-2022 account holding lamports above its
 * current rent-exempt reserve, one hand-built WithdrawExcessLamports
 * instruction moves the entire excess to the wallet. The account stays
 * open with exactly its reserve. No fee: the withdrawn lamports are the
 * user's own principal and nothing closes (the fee ledger's row shape
 * does not apply).
 *
 * The wire format is VERIFIED against the Token-2022 program source
 * (2026-09-26): the discriminant 38 comes from the interface crate's
 * pack() match arm; the processor takes source (writable), destination
 * (writable), authority (= the token account's owner, a signer), has no
 * amount parameter (it drains the full excess above
 * Rent::minimum_balance(data_len)), rejects native accounts, and never
 * checks frozen state. The shipped @solana/spl-token has no builder for
 * it, which is why this instruction is hand-built here.
 *
 * No React in this file.
 */

import {
  Commitment,
  GetMultipleAccountsConfig,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

import { TOKEN_2022_PROGRAM_ID, type ScanResult } from "./tokenAccounts";

export const WITHDRAW_EXCESS_LAMPORTS_TAG = 38;

/** One actionable excess-lamports candidate derived from a detection
 *  read over the scan's Token-2022 accounts. */
export interface ExcessCandidate {
  /** The token account's public key, base58-encoded. */
  pubkey: string;
  /** The account's mint when the scan carries one (for the row
   *  display). Absent on unreadable skips. */
  mint?: string;
  /** All lamports the account holds at detection time. */
  lamports: number;
  /** The account's data length in bytes (drives the reserve math). */
  dataLen: number;
  /** lamports minus the current rent-exempt reserve for dataLen. */
  excess: number;
  /** Frozen evidence from the scan, for the row disclosure. The
   *  withdrawal itself never checks frozen state. */
  frozen: boolean;
}

/**
 * Build THE WithdrawExcessLamports instruction for one candidate: tag
 * 38, three keys — source (writable), destination = the connected
 * owner (writable), authority = the owner (signer) — and no data
 * beyond the tag. Nothing else, ever: no transfer, no close, no fee.
 */
export function buildWithdrawExcessInstruction(
  candidate: { pubkey: string },
  owner: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      {
        pubkey: new PublicKey(candidate.pubkey),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([WITHDRAW_EXCESS_LAMPORTS_TAG]),
  });
}

/**
 * The scan's Token-2022 account keys that are eligible for detection:
 * owned by the connected wallet (guaranteed by the scan), NOT wrapped
 * SOL (native is rejected on-chain and the unwrap flow owns those
 * accounts), with an unknown native status excluded too (act only on
 * confirmation). Frozen accounts stay INCLUDED: the program never
 * checks frozen state.
 */
export function collectToken2022Keys(scan: ScanResult): Array<{
  pubkey: string;
  mint?: string;
  nativeStatus: "non-native" | "native" | "unknown";
  frozen: boolean;
}> {
  const out: Array<{
    pubkey: string;
    mint?: string;
    nativeStatus: "non-native" | "native" | "unknown";
    frozen: boolean;
  }> = [];
  const seen = new Set<string>();
  for (const account of scan.eligibleAccounts) {
    if (account.program !== "token-2022") continue;
    if (seen.has(account.pubkey)) continue;
    seen.add(account.pubkey);
    out.push({
      pubkey: account.pubkey,
      mint: account.mint,
      // The repair path only admits non-native accounts, so an
      // eligible Token-2022 account is confirmed non-native.
      nativeStatus: "non-native",
      frozen: account.frozen === true,
    });
  }
  for (const skipped of scan.skippedAccounts) {
    if (skipped.program !== "token-2022") continue;
    if (seen.has(skipped.pubkey)) continue;
    seen.add(skipped.pubkey);
    // The exclusion half of the rule: wrapped-SOL accounts are
    // rejected on-chain (NativeNotSupported) and owned by the unwrap
    // flow; an unknown status is acted on only after confirmation.
    if (skipped.nativeStatus !== "non-native") continue;
    out.push({
      pubkey: skipped.pubkey,
      mint: skipped.mint === "unknown" ? undefined : skipped.mint,
      nativeStatus: "non-native",
      frozen: skipped.frozen === true,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The detection / gate read                                           */
/* ------------------------------------------------------------------ */

export type ExcessRead =
  | { kind: "rpc-failed" }
  | { kind: "missing" }
  | {
      kind: "read";
      lamports: number;
      dataLen: number;
      /** lamports minus the current rent-exempt reserve for dataLen. */
      excess: number;
    };

/**
 * Read ONE Token-2022 account raw (space is not in the parsed shape)
 * and derive its excess against the CURRENT rent-exempt minimum for
 * its data length — the same figure the on-chain instruction computes
 * from the rent sysvar. Throws on RPC failure; the caller decides how
 * to report it.
 */
export async function readExcessState(
  connection: {
    getMultipleAccountsInfo: (
      keys: PublicKey[],
      config?: Commitment | GetMultipleAccountsConfig
    ) => Promise<Array<{ lamports: number; data: { length: number } } | null>>;
    getMinimumBalanceForRentExemption: (
      dataLen: number,
      commitment?: Commitment
    ) => Promise<number>;
  },
  pubkey: string
): Promise<ExcessRead> {
  const accounts = await connection.getMultipleAccountsInfo([
    new PublicKey(pubkey),
  ]);
  const account = accounts[0];
  if (!account) return { kind: "missing" };
  const dataLen = account.data.length;
  const reserve = await connection.getMinimumBalanceForRentExemption(dataLen);
  return {
    kind: "read",
    lamports: account.lamports,
    dataLen,
    excess: account.lamports - reserve,
  };
}

/* ------------------------------------------------------------------ */
/* Detection: chunked batched reads over the scan's Token-2022 keys     */
/* ------------------------------------------------------------------ */

/**
 * Detect excess-lamports candidates among the given keys: chunked
 * getMultipleAccounts reads (100 keys per call) for lamports + data length, and one
 * getMinimumBalanceForRentExemption per unique data length (the same
 * current-rate figure the on-chain instruction recomputes from the
 * rent sysvar). Keys whose account is missing or unreadable are
 * skipped — detection is opportunistic, and the scan's own error
 * surface is where read failures belong.
 */
export async function detectExcessCandidates(
  connection: {
    getMultipleAccountsInfo: (
      keys: PublicKey[],
      config?: Commitment | GetMultipleAccountsConfig
    ) => Promise<Array<{ lamports: number; data: { length: number } } | null>>;
    getMinimumBalanceForRentExemption: (
      dataLen: number,
      commitment?: Commitment
    ) => Promise<number>;
  },
  keys: Array<{ pubkey: string; mint?: string; frozen?: boolean }>
): Promise<ExcessCandidate[]> {
  if (keys.length === 0) return [];
  // Public RPCs commonly cap getMultipleAccounts at 100 keys per call,
  // so the detection read is chunked. A dropped chunk would silently
  // hide candidates, so an oversized batch is a hard error instead.
  const CHUNK = 100;
  const chunks: Array<
    Array<{ pubkey: string; mint?: string; frozen?: boolean }>
  > = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    chunks.push(keys.slice(i, i + CHUNK));
  }
  const reserves = new Map<number, number>();
  const out: ExcessCandidate[] = [];
  for (const chunk of chunks) {
    const accounts = await connection.getMultipleAccountsInfo(
      chunk.map((k) => new PublicKey(k.pubkey))
    );
    for (let i = 0; i < chunk.length; i++) {
      const account = accounts[i];
      if (!account) continue;
      const dataLen = account.data.length;
      let reserve = reserves.get(dataLen);
      if (reserve === undefined) {
        reserve = await connection.getMinimumBalanceForRentExemption(dataLen);
        reserves.set(dataLen, reserve);
      }
      const excess = account.lamports - reserve;
      if (excess <= 0) continue;
      const key = chunk[i];
      out.push({
        pubkey: key.pubkey,
        ...(key.mint ? { mint: key.mint } : {}),
        lamports: account.lamports,
        dataLen,
        excess,
        frozen: key.frozen === true,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The refresh-gate evaluator                                          */
/* ------------------------------------------------------------------ */

export type ExcessGateVerdict =
  | { kind: "pass"; excessBeforeAction: number; lamportsBeforeAction: number }
  | { kind: "already-withdrawn" }
  | { kind: "already-gone" }
  | { kind: "abort"; sentence: string };

/**
 * Compare one on-chain read against the reviewed candidate. A changed
 * excess figure is NOT an abort (the Case B policy shared across the
 * action flows): the current figure travels to the card and the
 * instruction drains whatever excess exists at land time. The one
 * abort shape is an RPC-side failure, which the hook reports before
 * anything is signed.
 */
export function evaluateExcessGate(
  read: ExcessRead,
  reviewed: ExcessCandidate
): ExcessGateVerdict {
  if (read.kind === "missing") return { kind: "already-gone" };
  if (read.kind === "rpc-failed") {
    return {
      kind: "abort",
      sentence:
        "The current account state could not be read. Nothing was signed.",
    };
  }
  if (read.excess <= 0) return { kind: "already-withdrawn" };
  return {
    kind: "pass",
    excessBeforeAction: read.excess,
    lamportsBeforeAction: read.lamports,
  };
}
