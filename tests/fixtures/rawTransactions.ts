/**
 * Shared raw-transaction fixtures for the ledger and explainer tests.
 *
 * Single source, moved out of tests/feeLedger.test.ts so the explainer
 * tests run against the SAME shapes: builders that serialize through the
 * shipped web3.js (so the bytes are library-authoritative, never hand
 * modeled), plus the one embedded REAL chain transaction (a genuine devnet
 * v1 signature kept byte-for-byte in the getTransaction(base64) shape).
 *
 * buildV0LoadedAddressesRaw is the address-lookup-table case: its close
 * instruction references accounts that exist ONLY in
 * meta.loadedAddresses, so any decoder or explainer that looks at static
 * keys alone will miss them. Understating a transaction's account set is
 * the worst failure mode a safety tool can have, and it is silent, which
 * is why this fixture exists.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { RawTransaction } from "@/lib/solana/feeLedger";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@/lib/solana/tokenAccounts";

export const FEE_WALLET = "6qhajWTtUKadkMaumpADGBkmPkASiwXRqGtqd8ypL74K";
export const RECENT_BLOCKHASH = "11111111111111111111111111111111";
export const BLOCK_TIME = 1755577001;

export function systemTransfer(
  to: PublicKey,
  lamports: number
): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: Keypair.generate().publicKey,
    toPubkey: to,
    lamports,
  });
}

export function systemTransferWithSeed(
  to: PublicKey,
  lamports: number
): TransactionInstruction {
  // web3.js v1.x builds a TransferWithSeed whenever `basePubkey` is present
  // on SystemProgram.transfer params; there is no separate builder anymore.
  return SystemProgram.transfer({
    fromPubkey: Keypair.generate().publicKey,
    basePubkey: Keypair.generate().publicKey,
    seed: "fees",
    toPubkey: to,
    lamports,
    programId: SystemProgram.programId,
  });
}

export function closeIx(
  program: "spl" | "token-2022" = "spl",
  data: Buffer = Buffer.from([9])
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false },
    ],
    programId: program === "spl" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
    data,
  });
}

export type WireInstruction = {
  programIdIndex?: number;
  accounts?: number[];
  data?: string;
};

/** Build a raw getTransaction(base64) response for a legacy transaction.
 *  The compiled message is returned too so tests can move a compiled
 *  instruction into meta.innerInstructions (the exact CPI wire shape). */
export function buildLegacyRaw(
  instructions: TransactionInstruction[],
  opts: { err?: unknown; inner?: WireInstruction[] } = {}
): { raw: RawTransaction; message: ReturnType<Transaction["compileMessage"]> } {
  const tx = new Transaction({
    feePayer: Keypair.generate().publicKey,
    recentBlockhash: RECENT_BLOCKHASH,
  });
  for (const ix of instructions) tx.add(ix);
  const message = tx.compileMessage();
  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  return {
    raw: {
      blockTime: BLOCK_TIME,
      version: null,
      meta: {
        err: opts.err ?? null,
        innerInstructions: opts.inner
          ? [{ index: 0, instructions: opts.inner }]
          : [],
      },
      transaction: [serialized.toString("base64"), "base64"],
    },
    message,
  };
}

export function buildV0Raw(
  instructions: TransactionInstruction[]
): RawTransaction {
  const message = new TransactionMessage({
    payerKey: Keypair.generate().publicKey,
    recentBlockhash: RECENT_BLOCKHASH,
    instructions,
  }).compileToV0Message();
  const serialized = new VersionedTransaction(message).serialize();
  return {
    blockTime: BLOCK_TIME,
    version: 0,
    meta: {
      err: null,
      loadedAddresses: { readonly: [], writable: [] },
      innerInstructions: [],
    },
    transaction: [Buffer.from(serialized).toString("base64"), "base64"],
  };
}

/** A v0 transaction whose close instruction touches accounts that appear
 *  ONLY in meta.loadedAddresses (the address-lookup-table case). Returns
 *  the raw response plus the loaded-only addresses, so a test can pin that
 *  the decoded and EXPLAINED output names them. Wire assembled by hand
 *  because the library compiles lookup-table references differently; the
 *  layout (version 0x80, header, compact-u16 counts) is the v0 message
 *  format the shipped deserializer reads. */
export function buildV0LoadedAddressesRaw(): {
  raw: RawTransaction;
  loadedAccount: string;
  loadedDestination: string;
} {
  const payer = Keypair.generate().publicKey;
  const loadedAccount = Keypair.generate().publicKey;
  const loadedDestination = Keypair.generate().publicKey;
  // Static keys: payer (signer, writable), token program (readonly).
  // Loaded writable: the token account and the close destination, so the
  // instruction's account indexes 2 and 3 resolve only through loading.
  const message = Buffer.concat([
    Buffer.from([0x80]), // versioned marker
    Buffer.from([1, 0, 1]), // header: 1 signer, 0 readonly-signed, 1 readonly
    Buffer.from([0x02]), // static account count (compact-u16)
    payer.toBuffer(),
    TOKEN_PROGRAM_ID.toBuffer(),
    Buffer.alloc(32, 7), // blockhash, unread by the decoder
    Buffer.from([0x01]), // instruction count
    Buffer.from([0x01]), // programIdIndex: the token program
    Buffer.from([0x03]), // account count: 3
    Buffer.from([0x02, 0x03, 0x00]), // account indexes: into the loaded region
    Buffer.from([0x01]), // data length
    Buffer.from([9]), // CloseAccount
  ]);
  const serialized = Buffer.concat([
    Buffer.from([0x01]), // one signature
    Buffer.alloc(64),
    message,
  ]);
  return {
    raw: {
      blockTime: BLOCK_TIME,
      version: 0,
      meta: {
        err: null,
        loadedAddresses: {
          readonly: [],
          writable: [loadedAccount.toBase58(), loadedDestination.toBase58()],
        },
        innerInstructions: [],
      },
      transaction: [serialized.toString("base64"), "base64"],
    },
    loadedAccount: loadedAccount.toBase58(),
    loadedDestination: loadedDestination.toBase58(),
  };
}

/** A genuine devnet v1 transaction, signature
 *  3bXSKQ8DKAphwBF6DNbNoSzm9YWcmzMRN7Lz1jKs7AxEwhXA5NFtX6VNfWR6oy4LKDTwMnrm6RsijSeY4CwFdVeu
 *  (block 495676584, success), fetched 2026-09-09 from
 *  api.devnet.solana.com with maxSupportedTransactionVersion: 1 and kept
 *  byte-for-byte. Its one instruction is a compute-budget style op, so it
 *  must decode cleanly and explain as an honest unknown, nothing more. */
export const REAL_V1_BASE64 =
  "gQEAAQwAAABZrn9Geyy9QOyQBlOi5POqdxw3lJ789VaPIeuAHVOy8QEDUqHvuOWhBkVUFQrt+G3XhJZCwpfE/NeVgktJghRKPjLze4W/dXluLiYNnl29YfRnmbkQ4yo2Nvk1Ei319ZiWnM5S8s5diwsp/V9N7L1deOZqhkue15uANDp/kdfN7/jHwFwVAAAAEAACARIAARY4/h1NIL8lJwAAAAAAAAAABIHOjW5o9tgS9W0eqKzf0ajmbl/fCnfUEsXpYHLPdsvdJ0fBGlaGNAfEO6u8Sy9f5PUxXWW/nI9ldj5EUhnnFgY=";
export const REAL_V1_BLOCK_TIME = 1788965346;
export const REAL_V1_ADDRESSES = [
  "6ZZecuC9M7khPZzZZSN8o4vpa2bds6cFJiCSziVVf7e9",
  "HPTKEmtGSTdAmnZUkTtMqr6VEQDgMrGmi4xiWgVA5JKu",
  "EtQM4CYjv2rutiBkD4FDj5zFaPkxfQ9og6g2rzdu5hY2",
];

export function realV1Raw(
  overrides: Partial<RawTransaction> = {}
): RawTransaction {
  return {
    blockTime: REAL_V1_BLOCK_TIME,
    version: 1,
    meta: {
      err: null,
      loadedAddresses: { readonly: [], writable: [] },
      innerInstructions: [],
      preBalances: [283149512403, 168249600, 833120],
    },
    transaction: [REAL_V1_BASE64, "base64"],
    ...overrides,
  };
}

/** Assemble a minimal well-formed v1 envelope by hand (the bundled
 *  web3.js cannot compile one). Field layout per SIMD-0385:
 *  version 0x81 | header(3) | configMask(u32) | lifetime(32) |
 *  numInstructions | numAddresses | addresses (32 bytes each) |
 *  config values (4 bytes per set mask bit, none here) |
 *  per instruction: programIndex, accountCount, dataLength(u16 LE),
 *  account indexes, data | signatures at the tail (never read). */
export function buildV1RepairRaw(opts: {
  feeLamports: number;
  preBalances?: number[];
}): RawTransaction {
  const payer = Keypair.generate().publicKey;
  const tokenAccount = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const addresses = [
    payer,
    tokenAccount,
    owner,
    new PublicKey(FEE_WALLET),
    TOKEN_PROGRAM_ID,
    SystemProgram.programId,
  ];
  const transferData = Buffer.alloc(12);
  transferData.writeUInt32LE(2, 0); // SystemProgram transfer tag
  transferData.writeBigUInt64LE(BigInt(opts.feeLamports), 4);
  const instructions = [
    { programIndex: 4, accountIndexes: [1, 2, 2], data: Buffer.from([9]) },
    { programIndex: 5, accountIndexes: [0, 3], data: transferData },
  ];
  const parts: Buffer[] = [
    Buffer.from([0x81]),
    Buffer.from([1, 0, 0]), // header: 1 required signature
    Buffer.from([0, 0, 0, 0]), // configMask: no config requests
    Buffer.alloc(32, 7), // lifetime specifier
    Buffer.from([instructions.length]),
    Buffer.from([addresses.length]),
    ...addresses.map((k) => k.toBuffer()),
  ];
  // The SIMD puts ALL instruction headers first, THEN all payloads.
  const headers: Buffer[] = [];
  const payloads: Buffer[] = [];
  for (const ix of instructions) {
    const len = Buffer.alloc(2);
    len.writeUInt16LE(ix.data.length);
    headers.push(Buffer.from([ix.programIndex, ix.accountIndexes.length]), len);
    payloads.push(
      ...ix.accountIndexes.map((a) => Buffer.from([a])),
      ix.data
    );
  }
  parts.push(...headers, ...payloads);
  parts.push(Buffer.alloc(64)); // the one tail signature, unchecked
  return {
    blockTime: BLOCK_TIME,
    version: 1,
    meta: {
      err: null,
      loadedAddresses: { readonly: [], writable: [] },
      innerInstructions: [],
      preBalances: opts.preBalances ?? [1, 2_039_280, 1, 1, 1, 1],
    },
    transaction: [Buffer.concat(parts).toString("base64"), "base64"],
  };
}
