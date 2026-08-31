/**
 * Fixture tests for the fee ledger extraction layer (feeLedger.ts).
 *
 * Fixtures are REAL serialized transactions (built with the same
 * @solana/web3.js the app ships) wrapped in the getTransaction(base64)
 * response shape the public RPCs actually return. The amounts used are
 * the receipt-verified fee values already covered in fees.test.ts
 * (20,392 classic, 20,740 token-2022); the point here is the extraction
 * rules, not the fee math.
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Message,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  feeRowsFromRawTransactions,
  formatBlockTime,
  formatLamportsSol,
  type RawTransaction,
} from "@/lib/solana/feeLedger";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/solana/tokenAccounts";

const FEE_WALLET = "6qhajWTtUKadkMaumpADGBkmPkASiwXRqGtqd8ypL74K";
const SOMEONE_ELSE = Keypair.generate().publicKey;
const RECENT_BLOCKHASH = "11111111111111111111111111111111";
const BLOCK_TIME = 1755577001;

function systemTransfer(to: PublicKey, lamports: number): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: Keypair.generate().publicKey,
    toPubkey: to,
    lamports,
  });
}

function systemTransferWithSeed(to: PublicKey, lamports: number): TransactionInstruction {
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

function closeIx(
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

type WireInstruction = { programIdIndex?: number; accounts?: number[]; data?: string };

/** Build a raw getTransaction(base64) response for a legacy transaction. The
 *  compiled message is returned too so tests can move a compiled
 *  instruction into meta.innerInstructions (the exact CPI wire shape). */
function buildLegacyRaw(
  instructions: TransactionInstruction[],
  opts: { err?: unknown; inner?: WireInstruction[] } = {}
): { raw: RawTransaction; message: Message } {
  const tx = new Transaction({
    feePayer: Keypair.generate().publicKey,
    recentBlockhash: RECENT_BLOCKHASH,
  });
  for (const ix of instructions) tx.add(ix);
  const message = tx.compileMessage();
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return {
    raw: {
      blockTime: BLOCK_TIME,
      version: null,
      meta: {
        err: opts.err ?? null,
        innerInstructions: opts.inner ? [{ index: 0, instructions: opts.inner }] : [],
      },
      transaction: [serialized.toString("base64"), "base64"],
    },
    message,
  };
}

function buildV0Raw(instructions: TransactionInstruction[]): RawTransaction {
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

describe("feeRowsFromRawTransactions", () => {
  it("extracts a fee transfer from a repair transaction (token-2022 receipt)", () => {
    const { raw } = buildLegacyRaw([
      closeIx("token-2022"),
      systemTransfer(new PublicKey(FEE_WALLET), 20_740),
    ]);
    const rows = feeRowsFromRawTransactions([{ signature: "sig1", raw }], FEE_WALLET);
    expect(rows).toEqual([{ signature: "sig1", blockTime: BLOCK_TIME, lamports: 20_740 }]);
  });

  it("extracts from a classic (spl-token) repair too", () => {
    const { raw } = buildLegacyRaw([
      closeIx("spl"),
      systemTransfer(new PublicKey(FEE_WALLET), 20_392),
    ]);
    const rows = feeRowsFromRawTransactions([{ signature: "classic", raw }], FEE_WALLET);
    expect(rows).toEqual([{ signature: "classic", blockTime: BLOCK_TIME, lamports: 20_392 }]);
  });

  it("extracts from a versioned (v0) transaction", () => {
    const raw = buildV0Raw([
      closeIx(),
      systemTransfer(new PublicKey(FEE_WALLET), 20_740),
    ]);
    const rows = feeRowsFromRawTransactions([{ signature: "v0", raw }], FEE_WALLET);
    expect(rows).toEqual([{ signature: "v0", blockTime: BLOCK_TIME, lamports: 20_740 }]);
  });

  it("excludes the seed funding (a transfer with no closeAccount)", () => {
    const { raw } = buildLegacyRaw([systemTransfer(new PublicKey(FEE_WALLET), 12_620_000)]);
    expect(feeRowsFromRawTransactions([{ signature: "seed", raw }], FEE_WALLET)).toEqual([]);
  });

  it("excludes failed transactions", () => {
    const { raw } = buildLegacyRaw(
      [closeIx(), systemTransfer(new PublicKey(FEE_WALLET), 20_392)],
      { err: { InstructionError: [0, "Custom"] } }
    );
    expect(feeRowsFromRawTransactions([{ signature: "failed", raw }], FEE_WALLET)).toEqual([]);
  });

  it("skips pruned transactions (null entry or null transaction) silently", () => {
    const { raw: okRaw } = buildLegacyRaw([
      closeIx(),
      systemTransfer(new PublicKey(FEE_WALLET), 20_392),
    ]);
    const prunedField: RawTransaction = { transaction: null };
    const rows = feeRowsFromRawTransactions(
      [
        { signature: "pruned", raw: null },
        { signature: "pruned-field", raw: prunedField },
        { signature: "ok", raw: okRaw },
      ],
      FEE_WALLET
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].signature).toBe("ok");
  });

  it("ignores transfers that do not land in the fee wallet", () => {
    const { raw } = buildLegacyRaw([closeIx(), systemTransfer(SOMEONE_ELSE, 99_999)]);
    expect(feeRowsFromRawTransactions([{ signature: "elsewhere", raw }], FEE_WALLET)).toEqual([]);
  });

  it("scans inner (CPI) instructions and sums them with top-level transfers", () => {
    // The message carries two top-level transfers (20,000 + 392). A copy of
    // the compiled 392 transfer also appears in meta.innerInstructions, the
    // exact wire shape of a CPI transfer in a real getTransaction response.
    // If inner instructions were ignored the total would be 20,392; the
    // extraction sums every inbound transfer, top and inner, so it is 20,784.
    const { raw, message } = buildLegacyRaw([
      closeIx(),
      systemTransfer(new PublicKey(FEE_WALLET), 20_000),
      systemTransfer(new PublicKey(FEE_WALLET), 392),
    ]);
    raw.meta!.innerInstructions = [{ index: 0, instructions: [message.instructions[2]] }];
    const rows = feeRowsFromRawTransactions([{ signature: "cpi", raw }], FEE_WALLET);
    expect(rows).toEqual([{ signature: "cpi", blockTime: BLOCK_TIME, lamports: 20_784 }]);
  });

  it("counts transferWithSeed instructions", () => {
    const { raw } = buildLegacyRaw([
      closeIx(),
      systemTransferWithSeed(new PublicKey(FEE_WALLET), 20_392),
    ]);
    const rows = feeRowsFromRawTransactions([{ signature: "seeded", raw }], FEE_WALLET);
    expect(rows[0].lamports).toBe(20_392);
  });

  it("sums multiple inbound transfers in one transaction", () => {
    const { raw } = buildLegacyRaw([
      closeIx(),
      systemTransfer(new PublicKey(FEE_WALLET), 20_000),
      systemTransfer(new PublicKey(FEE_WALLET), 392),
    ]);
    const rows = feeRowsFromRawTransactions([{ signature: "multi", raw }], FEE_WALLET);
    expect(rows[0].lamports).toBe(20_392);
  });

  it("requires the closeAccount data to be exactly the tag byte", () => {
    const { raw } = buildLegacyRaw([
      closeIx("spl", Buffer.from([9, 0])),
      systemTransfer(new PublicKey(FEE_WALLET), 20_392),
    ]);
    expect(feeRowsFromRawTransactions([{ signature: "t22extras", raw }], FEE_WALLET)).toEqual([]);
  });

  it("requires the closeAccount to target a real token program", () => {
    const other = new TransactionInstruction({
      keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
      programId: SystemProgram.programId,
      data: Buffer.from([9]),
    });
    const { raw } = buildLegacyRaw([other, systemTransfer(new PublicKey(FEE_WALLET), 20_392)]);
    expect(feeRowsFromRawTransactions([{ signature: "notatoken", raw }], FEE_WALLET)).toEqual([]);
  });

  it("keeps the RPC's newest-first order across entries", () => {
    const a = buildLegacyRaw([closeIx(), systemTransfer(new PublicKey(FEE_WALLET), 20_740)]);
    const b = buildLegacyRaw([closeIx(), systemTransfer(new PublicKey(FEE_WALLET), 20_392)]);
    const rows = feeRowsFromRawTransactions(
      [
        { signature: "newest", raw: a.raw },
        { signature: "oldest", raw: b.raw },
      ],
      FEE_WALLET
    );
    expect(rows.map((r) => r.signature)).toEqual(["newest", "oldest"]);
  });

  it("keeps a row when blockTime is missing (null blockTime, dash at display time)", () => {
    const { raw } = buildLegacyRaw([closeIx(), systemTransfer(new PublicKey(FEE_WALLET), 20_392)]);
    raw.blockTime = null;
    const rows = feeRowsFromRawTransactions([{ signature: "notime", raw }], FEE_WALLET);
    expect(rows[0].blockTime).toBeNull();
  });
});

describe("formatLamportsSol", () => {
  it("trims trailing zeros (token-2022 receipt: 0.00002074)", () => {
    expect(formatLamportsSol(20_740)).toBe("0.00002074");
  });

  it("keeps significant trailing digits (classic receipt: 0.000020392)", () => {
    expect(formatLamportsSol(20_392)).toBe("0.000020392");
  });

  it("sums the three known self-test fees", () => {
    expect(formatLamportsSol(20_740 + 20_392 + 20_740)).toBe("0.000061872");
  });

  it("handles whole SOL and zero", () => {
    expect(formatLamportsSol(2_039_280_000)).toBe("2.03928");
    expect(formatLamportsSol(0)).toBe("0");
  });
});

describe("formatBlockTime", () => {
  it("renders UTC with minutes precision", () => {
    const t = Math.floor(Date.UTC(2026, 7, 19, 3, 36, 41) / 1000);
    expect(formatBlockTime(t)).toBe("2026-08-19 03:36 UTC");
  });

  it("renders a dash for a missing blockTime", () => {
    expect(formatBlockTime(null)).toBe("—");
  });
});

describe("FEE_LEDGER_ENDPOINTS selection", () => {
  // The endpoints object is computed at module load, so these tests reload
  // the module with the env var stubbed.

  it("mainnet uses the dedicated endpoint when NEXT_PUBLIC_MAINNET_RPC_ENDPOINT is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINNET_RPC_ENDPOINT", "https://example-rpc.example");
    vi.resetModules();
    const mod = await import("@/lib/solana/feeLedger");
    expect(mod.FEE_LEDGER_ENDPOINTS["mainnet-beta"]).toBe(
      "https://example-rpc.example"
    );
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("mainnet falls back to the public endpoint when unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINNET_RPC_ENDPOINT", undefined);
    vi.resetModules();
    const mod = await import("@/lib/solana/feeLedger");
    expect(mod.FEE_LEDGER_ENDPOINTS["mainnet-beta"]).toBe(
      "https://api.mainnet-beta.solana.com"
    );
    expect(mod.FEE_LEDGER_ENDPOINTS.devnet).toBe("https://api.devnet.solana.com");
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
