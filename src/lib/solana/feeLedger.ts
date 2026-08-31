/**
 * Fee ledger data layer.
 *
 * The fee ledger page shows every 1% fee the tool has charged, straight
 * from chain data, in the browser. This module holds the read-only RPC
 * fetch + extraction logic; nothing here builds or signs anything.
 *
 * "A fee" is defined reproducibly: a System transfer INTO the fee wallet
 * that happened inside a repair transaction (a transaction that also
 * contains a token-program closeAccount instruction). That definition
 * excludes the fee wallet's initial seed funding, which was a plain
 * transfer and is not a fee.
 *
 * Why transactions are fetched base64-encoded and decoded here: the public
 * Solana endpoints no longer serve parsed transactions (getParsedTransaction
 * returns "Method not found", and getTransaction ignores parsed encodings —
 * verified against api.mainnet-beta.solana.com and api.devnet.solana.com on
 * 2026-08-29). The two methods that are guaranteed everywhere are
 * getSignaturesForAddress and getTransaction(base64), so this module leans
 * on exactly those. Decoding uses @solana/web3.js, the same library the
 * rest of the app already depends on.
 */

import bs58 from "bs58";
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedMessage,
  type Message,
  type MessageV0,
} from "@solana/web3.js";

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./tokenAccounts";

/** Endpoints for the ledger. The devnet tab always uses the public devnet
 *  endpoint. The mainnet tab uses the same dedicated provider endpoint the
 *  app's mainnet build already uses (NEXT_PUBLIC_MAINNET_RPC_ENDPOINT) when
 *  one is configured, because the public mainnet endpoint now refuses
 *  browser requests outright: any request carrying an Origin header gets
 *  "Access forbidden" (403) — verified 2026-08-29 against
 *  api.mainnet-beta.solana.com, and the one keyless alternative
 *  (solana-rpc.publicnode.com) returns null for older transactions, which
 *  would silently drop rows. Without a configured endpoint the mainnet tab
 *  falls back to the public one, which still serves headerless clients
 *  (curl, node) and keeps the ledger reproducible: a row is defined the
 *  same way and can be re-derived against any RPC. */
const MAINNET_LEDGER_ENDPOINT = process.env.NEXT_PUBLIC_MAINNET_RPC_ENDPOINT;

export const FEE_LEDGER_ENDPOINTS = {
  "mainnet-beta":
    MAINNET_LEDGER_ENDPOINT ?? "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
} as const;

export type FeeLedgerCluster = keyof typeof FEE_LEDGER_ENDPOINTS;

/** One row of the ledger. Amounts are integer lamports; formatting to SOL
 *  happens at display time. */
export type FeeLedgerRow = {
  signature: string;
  /** Unix seconds from the RPC's blockTime, or null if the node omitted it. */
  blockTime: number | null;
  lamports: number;
};

export const FEE_LEDGER_PAGE_SIZE = 25;

/** Mainnet fee signatures known (receipt-verified, operator-logged) to be
 *  self-tests or family tests rather than organic fees. The ledger tags
 *  these rows so the public page stays honest about what is real revenue.
 *
 *  The rule is deliberately signature-based: a real user's signature can
 *  never appear here, so a real fee can never be mislabeled as a test.
 *  When the operator runs a new mainnet test, its signature is verified
 *  on-chain and added to this list in the next release. Devnet needs no
 *  list: devnet SOL is test funds by definition, so every devnet row is
 *  a test row. */
const MAINNET_TEST_SIGNATURES: ReadonlySet<string> = new Set([
  // Aug 19 self-test, Token-2022 close.
  "i7Riy8r8TSts5dSoYayhjVUuRfkf4CTsd3JtYdVEFTjCNwEhMHhhJqMeeLkAyoGdHunvvsq7pZZwNcj6A7udhzY",
  // Aug 19 self-test, classic SPL close.
  "4GnC4yuZUB2sC1Ft6aFP4ouhfaBKgHmAJBpYK4cCSVqeEmFUouDQorsSsUxw2wpnU2DqrM5CswPdphvagPqcPswi",
  // Aug 29 family test.
  "qsbutSckYFLtSXXV9ewBsWqoPMePdpFcafuCR8pEXeu9yVUQLaAEMVwxV3wEv1cchn6ge3LTFYSCKXjn97yznPQ",
  // Aug 30 owner self-test: CLUG Token-2022 close through the live site.
  "4BsA9nPxEePuHpNyN8KYzZYbCZyWVADojyiv4JvXvDxzpDt17Xq3n2Dc41fsqtaJH2FjYqhC5ectmUepbD2g9aAB",
]);

/** True when a ledger row is a known test fee, not organic revenue. */
export function isKnownTestFee(
  cluster: FeeLedgerCluster,
  signature: string
): boolean {
  if (cluster === "devnet") return true;
  return MAINNET_TEST_SIGNATURES.has(signature);
}

/** Error thrown when the ledger's RPC calls fail. `kind` drives the
 *  user-facing message; the page never shows raw error text. */
export class LedgerFetchError extends Error {
  constructor(
    public readonly kind: "network" | "rate-limited" | "rpc"
  ) {
    super(`fee ledger RPC failure: ${kind}`);
    this.name = "LedgerFetchError";
  }
}

/** One decoded instruction: the program it targets, the account pubkeys it
 *  references (in order), and its raw data bytes. Never rendered directly;
 *  the page shows amounts, signatures, dates, and nothing else. */
export type DecodedInstruction = {
  programId: string;
  accountPubkeys: string[];
  data: Uint8Array;
};

/** The shape getTransaction(base64) actually returns. Everything optional:
 *  the page must degrade to an honest empty state rather than crash on an
 *  unexpected shape. */
export type RawTransaction = {
  blockTime?: number | null;
  /** null or "legacy" for legacy, 0 for versioned transactions. */
  version?: number | string | null;
  meta?: {
    err?: unknown;
    loadedAddresses?: { readonly?: string[]; writable?: string[] };
    innerInstructions?: {
      index?: number;
      instructions?: {
        accounts?: number[];
        data?: string;
        programIdIndex?: number;
      }[];
    }[];
  };
  /** [base64String, "base64"] for a present transaction, null when pruned. */
  transaction?: unknown;
};

/* CloseAccount is the token program's instruction tag 9 in both the
 * classic SPL program and Token-2022; the data is the tag byte alone. */
const CLOSE_ACCOUNT_TAG = 9;

/* System program instruction tags: Transfer = 2, TransferWithSeed = 11.
 * Both put the lamports u64 at byte offset 4. */
const SYSTEM_TRANSFER_TAG = 2;
const SYSTEM_TRANSFER_WITH_SEED_TAG = 11;

function readU32LE(data: Uint8Array): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
}

function readU64LE(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(0, true);
}

/** Compact-u16 length decode, as used for the signature-count prefix of a
 *  serialized transaction. Returns the value and how many bytes it took. */
function decodeLengthPrefix(bytes: Uint8Array): { value: number; bytesRead: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    if (size >= bytes.length) return { value: 0, bytesRead: size };
    const elem = bytes[size];
    value |= (elem & 0x7f) << (size * 7);
    size += 1;
    if ((elem & 0x80) === 0) break;
  }
  return { value, bytesRead: size };
}

/** Resolve one wire-format instruction (programIdIndex + account indexes +
 *  base58 data) against the transaction's account key list. Returns null
 *  when anything is unresolvable — better to drop the instruction than to
 *  guess. */
function resolveInstruction(
  ix: { accounts?: number[]; data?: string; programIdIndex?: number },
  keys: readonly (PublicKey | undefined)[]
): DecodedInstruction | null {
  if (typeof ix.programIdIndex !== "number") return null;
  const programId = keys[ix.programIdIndex]?.toBase58();
  if (!programId) return null;
  const accountPubkeys: string[] = [];
  for (const index of ix.accounts ?? []) {
    const pubkey = keys[index]?.toBase58();
    if (!pubkey) return null;
    accountPubkeys.push(pubkey);
  }
  let data: Uint8Array;
  try {
    data = bs58.decode(ix.data ?? "");
  } catch {
    return null;
  }
  return { programId, accountPubkeys, data };
}

/**
 * Decode a raw getTransaction(base64) response into the instructions the
 * fee definition cares about: top-level plus inner (CPI) instructions, in
 * one list, account indexes resolved. Returns null for pruned or
 * unrecognizable transactions.
 *
 * Only the pubkeys needed for fee detection are materialized; nothing is
 * stored or forwarded anywhere.
 */
export function decodeRawTransaction(raw: RawTransaction): {
  blockTime: number | null;
  instructions: DecodedInstruction[];
} | null {
  const txData = raw.transaction;
  if (
    !Array.isArray(txData) ||
    typeof txData[0] !== "string" ||
    txData[1] !== "base64" ||
    txData[0].length === 0
  ) {
    return null;
  }
  let message: Message | MessageV0;
  try {
    // The base64 payload is a full serialized transaction: a compact-u16
    // signature count, that many 64-byte signatures, then the message.
    // VersionedMessage.deserialize expects the message bytes alone.
    const bytes = Buffer.from(txData[0], "base64");
    const { value: signatureCount, bytesRead } = decodeLengthPrefix(bytes);
    const offset = bytesRead + signatureCount * 64;
    message = VersionedMessage.deserialize(bytes.subarray(offset));
  } catch {
    return null;
  }

  let instructions: DecodedInstruction[];
  if (message.version === "legacy") {
    const keys: readonly (PublicKey | undefined)[] = message.accountKeys;
    const top = message.instructions
      .map((ix) => resolveInstruction(ix, keys))
      .filter((ix): ix is DecodedInstruction => ix !== null);
    const inner = (raw.meta?.innerInstructions ?? []).flatMap((group) =>
      (group.instructions ?? [])
        .map((ix) => resolveInstruction(ix, keys))
        .filter((ix): ix is DecodedInstruction => ix !== null)
    );
    instructions = [...top, ...inner];
  } else {
    // Versioned transactions resolve some accounts through address lookup
    // tables; getTransaction returns the loaded addresses in meta.
    const accountKeysFromLookups = {
      writable: (raw.meta?.loadedAddresses?.writable ?? []).map(
        (s) => new PublicKey(s)
      ),
      readonly: (raw.meta?.loadedAddresses?.readonly ?? []).map(
        (s) => new PublicKey(s)
      ),
    };
    const decompiled = TransactionMessage.decompile(message, {
      accountKeysFromLookups,
    });
    const keySet = message.getAccountKeys({ accountKeysFromLookups });
    const top: DecodedInstruction[] = decompiled.instructions.map((ix) => ({
      programId: ix.programId.toBase58(),
      accountPubkeys: ix.keys.map((k) => k.pubkey.toBase58()),
      data: ix.data,
    }));
    const keys = (index: number) => keySet.get(index);
    const inner = (raw.meta?.innerInstructions ?? []).flatMap((group) =>
      (group.instructions ?? [])
        .map((ix) => {
          if (typeof ix.programIdIndex !== "number") return null;
          const programId = keys(ix.programIdIndex)?.toBase58();
          if (!programId) return null;
          let data: Uint8Array;
          try {
            data = bs58.decode(ix.data ?? "");
          } catch {
            return null;
          }
          const accountPubkeys: string[] = [];
          for (const index of ix.accounts ?? []) {
            const pubkey = keys(index)?.toBase58();
            if (!pubkey) return null;
            accountPubkeys.push(pubkey);
          }
          return { programId, accountPubkeys, data };
        })
        .filter((ix): ix is DecodedInstruction => ix !== null)
    );
    instructions = [...top, ...inner];
  }

  return {
    blockTime: typeof raw.blockTime === "number" ? raw.blockTime : null,
    instructions,
  };
}

function isCloseAccount(ix: DecodedInstruction): boolean {
  const programId = ix.programId;
  return (
    (programId === TOKEN_PROGRAM_ID.toBase58() ||
      programId === TOKEN_2022_PROGRAM_ID.toBase58()) &&
    ix.data.length === 1 &&
    ix.data[0] === CLOSE_ACCOUNT_TAG
  );
}

/** Lamports a decoded instruction moved INTO the fee wallet, or 0. */
function inboundTransferLamports(
  ix: DecodedInstruction,
  feeWallet: string
): number {
  if (ix.programId !== SystemProgram.programId.toBase58()) return 0;
  if (ix.data.length < 12) return 0;
  const tag = readU32LE(ix.data);
  let destination: string | undefined;
  if (tag === SYSTEM_TRANSFER_TAG) {
    destination = ix.accountPubkeys[1];
  } else if (tag === SYSTEM_TRANSFER_WITH_SEED_TAG) {
    destination = ix.accountPubkeys[2];
  } else {
    return 0;
  }
  if (destination !== feeWallet) return 0;
  const lamports = Number(readU64LE(ix.data.subarray(4)));
  return Number.isSafeInteger(lamports) && lamports > 0 ? lamports : 0;
}

/**
 * Turn raw getTransaction responses (keyed by signature) into ledger rows.
 *
 * Skips, silently, exactly as the page spec requires: failed transactions,
 * pruned transactions (RPC returned null), and transactions that are not
 * repair transactions (e.g. the seed funding). Multiple inbound transfers
 * in one transaction are summed.
 */
export function feeRowsFromRawTransactions(
  entries: { signature: string; raw: RawTransaction | null }[],
  feeWallet: string
): FeeLedgerRow[] {
  const rows: FeeLedgerRow[] = [];
  for (const { signature, raw } of entries) {
    if (!raw || raw.meta?.err != null) continue;
    const decoded = decodeRawTransaction(raw);
    if (!decoded) continue;
    if (!decoded.instructions.some(isCloseAccount)) continue;
    const lamports = decoded.instructions.reduce(
      (sum, ix) => sum + inboundTransferLamports(ix, feeWallet),
      0
    );
    if (lamports <= 0) continue;
    rows.push({ signature, blockTime: decoded.blockTime, lamports });
  }
  return rows;
}

/** Lamports to SOL with nine decimals, trailing zeros trimmed:
 *  20_740 -> "0.00002074", 2_039_280_000 -> "2.03928", 0 -> "0". */
export function formatLamportsSol(lamports: number): string {
  const fixed = (lamports / 1e9).toFixed(9);
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

/** blockTime (unix seconds) to "2026-08-19 03:36 UTC". Null becomes an
 *  honest dash; the row stays listed. */
export function formatBlockTime(blockTime: number | null): string {
  if (blockTime == null) return "—";
  const d = new Date(blockTime * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
}

async function rpcCall(
  endpoint: string,
  method: string,
  params: unknown[]
): Promise<unknown> {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
  } catch {
    throw new LedgerFetchError("network");
  }
  // The public endpoints burst-throttle. Retry a 429 a couple of times with
  // growing backoff before the page surfaces its rate-limited state; the
  // total added delay stays under ~4.5s. A failed fallback endpoint would
  // under-report rows, so there is deliberately NO endpoint fallback here —
  // an honest error beats an incomplete ledger.
  for (const waitMs of [1200, 3000]) {
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, waitMs));
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
    } catch {
      throw new LedgerFetchError("network");
    }
  }
  if (res.status === 429) throw new LedgerFetchError("rate-limited");
  if (!res.ok) throw new LedgerFetchError("rpc");
  let body: { error?: unknown; result?: unknown };
  try {
    body = await res.json();
  } catch {
    throw new LedgerFetchError("rpc");
  }
  if (body.error) throw new LedgerFetchError("rpc");
  return body.result;
}

export type LedgerSignatureInfo = {
  signature: string;
  blockTime: number | null;
};

export async function fetchFeeSignatures(
  endpoint: string,
  feeWallet: string,
  before?: string
): Promise<LedgerSignatureInfo[]> {
  const params: unknown[] = [
    feeWallet,
    { limit: FEE_LEDGER_PAGE_SIZE, ...(before ? { before } : {}) },
  ];
  const result = (await rpcCall(
    endpoint,
    "getSignaturesForAddress",
    params
  )) as Array<{ signature?: string; blockTime?: number | null }> | null;
  return (result ?? [])
    .filter((r) => typeof r.signature === "string")
    .map((r) => ({
      signature: r.signature as string,
      blockTime: typeof r.blockTime === "number" ? r.blockTime : null,
    }));
}

export async function fetchRawTransaction(
  endpoint: string,
  signature: string
): Promise<RawTransaction | null> {
  // base64 encoding: the only transaction form the public endpoints still
  // serve. maxSupportedTransactionVersion lets versioned transactions
  // through instead of erroring.
  const result = await rpcCall(endpoint, "getTransaction", [
    signature,
    { maxSupportedTransactionVersion: 0, encoding: "base64" },
  ]);
  return (result ?? null) as RawTransaction | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `task` over `items` with at most `limit` in flight and an optional
 *  delay before each task starts. The pacing keeps a page fetch from
 *  arriving as a burst: the public endpoints' burst throttles are
 *  triggered by many getTransaction calls in quick succession. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
  startDelayMs = 0
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      if (startDelayMs > 0) await sleep(startDelayMs);
      results[i] = await task(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

/**
 * Fetch one page of the ledger: the fee wallet's latest signatures, each
 * fetched raw and decoded, extracted into rows. Newest-first, as the RPC
 * returns them.
 */
export async function fetchFeeLedgerPage(
  endpoint: string,
  feeWallet: string,
  before?: string
): Promise<FeeLedgerRow[]> {
  const signatures = await fetchFeeSignatures(endpoint, feeWallet, before);
  const entries = await mapWithConcurrency(
    signatures,
    2,
    async (s) => ({
      signature: s.signature,
      raw: await fetchRawTransaction(endpoint, s.signature),
    }),
    // ~150ms per started call (2 workers -> ~75ms per call) smooths the
    // page's 25+ transaction fetches out of burst territory.
    150
  );
  return feeRowsFromRawTransactions(entries, feeWallet);
}
