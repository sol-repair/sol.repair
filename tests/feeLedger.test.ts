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
import fc from "fast-check";
import { describe, expect, it, vi, afterEach } from "vitest";

import {
  LedgerFetchError,
  decodeRawTransaction,
  feeRowsFromRawTransactions,
  fetchFeeLedgerPage,
  formatBlockTime,
  formatLamportsSol,
  isKnownTestFee,
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
    expect(rows).toEqual([{ signature: "sig1", blockTime: BLOCK_TIME, lamports: 20_740, onePercentMatch: null }]);
  });

  it("extracts from a classic (spl-token) repair too", () => {
    const { raw } = buildLegacyRaw([
      closeIx("spl"),
      systemTransfer(new PublicKey(FEE_WALLET), 20_392),
    ]);
    const rows = feeRowsFromRawTransactions([{ signature: "classic", raw }], FEE_WALLET);
    expect(rows).toEqual([{ signature: "classic", blockTime: BLOCK_TIME, lamports: 20_392, onePercentMatch: null }]);
  });

  it("extracts from a versioned (v0) transaction", () => {
    const raw = buildV0Raw([
      closeIx(),
      systemTransfer(new PublicKey(FEE_WALLET), 20_740),
    ]);
    const rows = feeRowsFromRawTransactions([{ signature: "v0", raw }], FEE_WALLET);
    expect(rows).toEqual([{ signature: "v0", blockTime: BLOCK_TIME, lamports: 20_740, onePercentMatch: null }]);
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
    expect(rows).toEqual([{ signature: "cpi", blockTime: BLOCK_TIME, lamports: 20_784, onePercentMatch: null }]);
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

describe("feeRowsFromRawTransactions 1% conformance (onePercentMatch)", () => {
  /** closeAccount for a KNOWN token account, so the test can place that
   *  account's pre-tx rent into meta.preBalances at its message index. */
  function closeIxFor(account: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      keys: [
        { pubkey: account, isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false },
      ],
      programId: TOKEN_PROGRAM_ID,
      data: Buffer.from([9]),
    });
  }

  /** preBalances for a legacy fixture: the given rent on the closed
   *  account, 1 lamport on everything else (other accounts' balances are
   *  irrelevant to the check). */
  function preBalancesFor(
    message: Message,
    account: PublicKey,
    rent: number
  ): number[] {
    return message.accountKeys.map((k) => (k.equals(account) ? rent : 1));
  }

  it("marks a fee that is exactly floor(1%) of the freed rent as conforming", () => {
    // Today's live devnet repair, exact on-chain numbers: two closes
    // freeing 1,856,000 + 1,886,803 = 3,742,803 rent (the UI's 0.001887
    // display is 6-decimal rounding of 1,886,803 — the balance
    // arithmetic 3,625,375 + 37,428 + 80,000 fixes the exact total),
    // fee 37,428 = floor(3,742,803 / 100).
    const accountA = Keypair.generate().publicKey;
    const accountB = Keypair.generate().publicKey;
    const { raw, message } = buildLegacyRaw([
      closeIxFor(accountA),
      closeIxFor(accountB),
      systemTransfer(new PublicKey(FEE_WALLET), 37_428),
    ]);
    raw.meta!.preBalances = message.accountKeys.map((k) =>
      k.equals(accountA) ? 1_856_000 : k.equals(accountB) ? 1_886_803 : 1
    );
    const rows = feeRowsFromRawTransactions([{ signature: "today", raw }], FEE_WALLET);
    expect(rows[0].onePercentMatch).toBe(true);
  });

  it("marks a fee one lamport off the 1% rule as non-conforming", () => {
    // rent 2,039,280 -> floor(1%) = 20,392; 20,391 is a mismatch.
    const account = Keypair.generate().publicKey;
    const { raw, message } = buildLegacyRaw([
      closeIxFor(account),
      systemTransfer(new PublicKey(FEE_WALLET), 20_391),
    ]);
    raw.meta!.preBalances = preBalancesFor(message, account, 2_039_280);
    const rows = feeRowsFromRawTransactions([{ signature: "off-by-one", raw }], FEE_WALLET);
    expect(rows[0].onePercentMatch).toBe(false);
  });

  it("marks an inflated crafted transfer as non-conforming", () => {
    // A crafted tx closing one rent-exempt account (2,039,280) while
    // transferring 100,000 to the fee wallet: a real fee would be 20,392.
    const account = Keypair.generate().publicKey;
    const { raw, message } = buildLegacyRaw([
      closeIxFor(account),
      systemTransfer(new PublicKey(FEE_WALLET), 100_000),
    ]);
    raw.meta!.preBalances = preBalancesFor(message, account, 2_039_280);
    const rows = feeRowsFromRawTransactions([{ signature: "crafted", raw }], FEE_WALLET);
    expect(rows[0].onePercentMatch).toBe(false);
  });

  it("does not judge when the response lacks preBalances (null, no tag)", () => {
    const account = Keypair.generate().publicKey;
    const { raw } = buildLegacyRaw([
      closeIxFor(account),
      systemTransfer(new PublicKey(FEE_WALLET), 20_392),
    ]);
    // no meta.preBalances at all: unverifiable, never accused
    const rows = feeRowsFromRawTransactions([{ signature: "noverdict", raw }], FEE_WALLET);
    expect(rows[0].onePercentMatch).toBeNull();
  });

  it("does not judge when the closed account is missing from preBalances", () => {
    const account = Keypair.generate().publicKey;
    const { raw } = buildLegacyRaw([
      closeIxFor(account),
      systemTransfer(new PublicKey(FEE_WALLET), 20_392),
    ]);
    // truncated preBalances: the index math cannot complete
    raw.meta!.preBalances = [1];
    const rows = feeRowsFromRawTransactions([{ signature: "short", raw }], FEE_WALLET);
    expect(rows[0].onePercentMatch).toBeNull();
  });

  it("checks v0 transactions too (static account keys order)", () => {
    const account = Keypair.generate().publicKey;
    const message = new TransactionMessage({
      payerKey: Keypair.generate().publicKey,
      recentBlockhash: RECENT_BLOCKHASH,
      instructions: [
        closeIxFor(account),
        systemTransfer(new PublicKey(FEE_WALLET), 20_392),
      ],
    }).compileToV0Message();
    const serialized = new VersionedTransaction(message).serialize();
    const raw: RawTransaction = {
      blockTime: BLOCK_TIME,
      version: 0,
      meta: {
        err: null,
        loadedAddresses: { readonly: [], writable: [] },
        innerInstructions: [],
        preBalances: message.staticAccountKeys.map((k) =>
          k.equals(account) ? 2_039_280 : 1
        ),
      },
      transaction: [Buffer.from(serialized).toString("base64"), "base64"],
    };
    const rows = feeRowsFromRawTransactions([{ signature: "v0check", raw }], FEE_WALLET);
    expect(rows[0].onePercentMatch).toBe(true);
  });
});

describe("isKnownTestFee", () => {
  it("tags the six known mainnet test signatures", () => {
    // Receipt-verified signatures: two Aug 19 self-tests, the Aug 29
    // family test, the Aug 30 owner self-test (CLUG close), the
    // Sep 4 owner test (Token-2022 close after a manual burn-to-zero),
    // and the Sep 10 first mainnet revoke+close run (staged delegate
    // plus two staged empties, verified on chain to the lamport).
    expect(
      isKnownTestFee(
        "mainnet-beta",
        "i7Riy8r8TSts5dSoYayhjVUuRfkf4CTsd3JtYdVEFTjCNwEhMHhhJqMeeLkAyoGdHunvvsq7pZZwNcj6A7udhzY"
      )
    ).toBe(true);
    expect(
      isKnownTestFee(
        "mainnet-beta",
        "4GnC4yuZUB2sC1Ft6aFP4ouhfaBKgHmAJBpYK4cCSVqeEmFUouDQorsSsUxw2wpnU2DqrM5CswPdphvagPqcPswi"
      )
    ).toBe(true);
    expect(
      isKnownTestFee(
        "mainnet-beta",
        "qsbutSckYFLtSXXV9ewBsWqoPMePdpFcafuCR8pEXeu9yVUQLaAEMVwxV3wEv1cchn6ge3LTFYSCKXjn97yznPQ"
      )
    ).toBe(true);
    expect(
      isKnownTestFee(
        "mainnet-beta",
        "4BsA9nPxEePuHpNyN8KYzZYbCZyWVADojyiv4JvXvDxzpDt17Xq3n2Dc41fsqtaJH2FjYqhC5ectmUepbD2g9aAB"
      )
    ).toBe(true);
    expect(
      isKnownTestFee(
        "mainnet-beta",
        "2EdGP7YSr2oKAtibpAFAnfUhAhsk8jFSaNKdUZz3z43wGrF9YR6BYvxePwhnrpx2PfhHbBE3bBCFTsbdybMauBww"
      )
    ).toBe(true);
    expect(
      isKnownTestFee(
        "mainnet-beta",
        "2ZMJZDi7frGRw7GxBGwDfc2MYqbjzhobt4r2sGEWcxGevnonMyjAconXKpCw74kLBEb8mjcCckvp2aVTimFC1m55"
      )
    ).toBe(true);
  });

  it("does not tag an unknown mainnet signature (a real fee can never match)", () => {
    expect(
      isKnownTestFee(
        "mainnet-beta",
        "5Xkd8WqNy32UmkbBBijgVJcYKEqmoYxZPcMWpUusEMkF1Sya3RfXRJqW1mffnPQKfCJuDnq4HpnSCUmDyKzEBkyz"
      )
    ).toBe(false);
  });

  it("tags every devnet signature: devnet SOL is test funds by definition", () => {
    expect(isKnownTestFee("devnet", "anything-at-all")).toBe(true);
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

describe("fetchFeeLedgerPage pagination (stubbed RPC)", () => {
  // The pagination contract: hasMore and the next cursor come from the RAW
  // signature page (newest-first, exactly what getSignaturesForAddress
  // returned), never from the filtered fee rows. A full 25-signature page
  // can legitimately hold zero fees (pruned, failed, or non-repair
  // transactions); judging by fee rows would end the ledger early.

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const feeTx = (lamports: number): RawTransaction =>
    buildLegacyRaw([closeIx(), systemTransfer(new PublicKey(FEE_WALLET), lamports)]).raw;

  /** Stub global fetch as a JSON-RPC server: getSignaturesForAddress is
   *  dispatched by the `before` cursor, getTransaction returns the fee
   *  fixtures for known signatures and null (pruned) for the rest. */
  function stubRpc(
    pages: { before?: string; signatures: string[]; fees: Record<string, number> }[]
  ) {
    const txs: Record<string, RawTransaction> = {};
    for (const p of pages) {
      for (const [sig, lamports] of Object.entries(p.fees)) txs[sig] = feeTx(lamports);
    }
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      let result: unknown;
      if (body.method === "getSignaturesForAddress") {
        const before = (body.params[1] as { before?: string } | undefined)?.before;
        const page = pages.find((p) => p.before === before);
        result = (page?.signatures ?? []).map((s) => ({ signature: s, blockTime: BLOCK_TIME }));
      } else {
        result = txs[body.params[0] as string] ?? null;
      }
      return { ok: true, status: 200, json: async () => ({ result }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("renders a signature the node serves twice in one page exactly once", async () => {
    // R4-3, edge 1: a node can repeat a signature inside a single
    // getSignaturesForAddress page. A repeated fee row would double-count
    // public revenue, so the page must dedupe by signature. Pagination
    // facts stay RAW: the page is still judged by exactly what the RPC
    // returned (25 served entries = maybe more pages, cursor = last raw
    // entry), dedup or not.
    const signatures = [
      "dup-fee",
      ...Array.from({ length: 23 }, (_, i) => `s-${i + 1}`),
      "dup-fee",
    ];
    stubRpc([{ signatures, fees: { "dup-fee": 20_392 } }]);

    const page = await fetchFeeLedgerPage("https://rpc.example", FEE_WALLET);

    expect(page.rows.map((r) => r.signature)).toEqual(["dup-fee"]);
    expect(page.rows[0].lamports).toBe(20_392);
    expect(page.rawSignatureCount).toBe(25);
    expect(page.lastRawSignature).toBe("dup-fee");
  });

  it("a full 25-signature page with zero fees still reports more pages and a raw cursor", async () => {
    const signatures = Array.from({ length: 25 }, (_, i) => `pruned-${i + 1}`);
    stubRpc([{ signatures, fees: {} }]);
    const page = await fetchFeeLedgerPage("https://rpc.example", FEE_WALLET);
    expect(page.rows).toHaveLength(0);
    expect(page.rawSignatureCount).toBe(25);
    expect(page.lastRawSignature).toBe("pruned-25");
  });

  it("continues from the raw cursor when a full page holds a single fee", async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => `s-${i + 1}`);
    const page2 = ["t-1", "t-2", "t-3"];
    const mock = stubRpc([
      { signatures: page1, fees: { "s-7": 20_392 } },
      { before: "s-25", signatures: page2, fees: { "t-2": 20_740 } },
    ]);

    const first = await fetchFeeLedgerPage("https://rpc.example", FEE_WALLET);
    expect(first.rows.map((r) => r.signature)).toEqual(["s-7"]);
    expect(first.rawSignatureCount).toBe(25);
    expect(first.lastRawSignature).toBe("s-25");

    // The next page must be requested with the RAW cursor (s-25), not the
    // last fee row (s-7), and the fee on it must land in the rows.
    const second = await fetchFeeLedgerPage(
      "https://rpc.example",
      FEE_WALLET,
      first.lastRawSignature!
    );
    expect(second.rows.map((r) => r.signature)).toEqual(["t-2"]);
    expect(second.rows[0].lamports).toBe(20_740);
    expect(second.rawSignatureCount).toBe(3);
    expect(second.lastRawSignature).toBe("t-3");

    const beforeArgs = mock.mock.calls
      .map((c) => JSON.parse(String((c[1] as { body?: string })?.body)))
      .filter((b: { method: string }) => b.method === "getSignaturesForAddress")
      .map((b: { params: { before?: string }[] }) => b.params[1]?.before);
    expect(beforeArgs).toEqual([undefined, "s-25"]);
  });

  it("requests each transaction with maxSupportedTransactionVersion: 1", async () => {
    // v1 transactions activate on mainnet (SIMD-0385, announced for
    // 2026-09-09; the on-chain gate account records the true date). From
    // that day, a getTransaction call pinned to version 0 errors when the
    // node returns a v1 transaction, which would fail the whole ledger
    // page. Version 1 is accepted by the public endpoints today and
    // returns legacy and v0 responses unchanged, so the page must already
    // be asking for it.
    const mock = stubRpc([{ signatures: ["s-1"], fees: {} }]);
    await fetchFeeLedgerPage("https://rpc.example", FEE_WALLET);

    const txParams = mock.mock.calls
      .map((c) => JSON.parse(String((c[1] as { body?: string })?.body)))
      .filter((b: { method: string }) => b.method === "getTransaction")
      .map((b: { params: unknown[] }) => b.params);
    expect(txParams).toEqual([
      ["s-1", { maxSupportedTransactionVersion: 1, encoding: "base64" }],
    ]);
  });
});

describe("decodeRawTransaction malformed v0 envelope data", () => {
  // Both fixtures start from a REAL serialized v0 transaction and
  // corrupt only the side envelope (meta.loadedAddresses) the network
  // delivers alongside it. The function's contract: garbage means
  // "unrecognizable transaction" -> null, never a throw that would
  // fail the whole ledger page as a misleading RPC error.

  it("returns null when a loaded address is not valid base58", () => {
    const raw = buildV0Raw([
      closeIx(),
      systemTransfer(new PublicKey(FEE_WALLET), 20_740),
    ]);
    raw.meta!.loadedAddresses = {
      writable: ["not-a-valid-public-key!!!"],
      readonly: [],
    };
    expect(decodeRawTransaction(raw)).toBeNull();
  });

  it("returns null when the loaded-address count disagrees with the message header", () => {
    // The compiled v0 message uses zero lookup keys; claiming one
    // writable loaded address makes getAccountKeys throw its
    // numAccountKeysFromLookups guard inside TransactionMessage.decompile.
    const raw = buildV0Raw([
      closeIx(),
      systemTransfer(new PublicKey(FEE_WALLET), 20_740),
    ]);
    raw.meta!.loadedAddresses = {
      writable: [Keypair.generate().publicKey.toBase58()],
      readonly: [],
    };
    expect(decodeRawTransaction(raw)).toBeNull();
  });
});

describe("decodeRawTransaction version-1 message boundary", () => {
  // v1 transactions activate on mainnet (SIMD-0385, announced for
  // 2026-09-09; the on-chain gate account records the true date). The
  // bundled @solana/web3.js cannot build or decode v1 messages yet, but
  // its deserializer throws a version assert on the 0x81 prefix. The
  // function's null-on-garbage contract must hold for that shape too: an
  // unrecognizable v1 transaction is skipped like a pruned one, never a
  // throw that fails the whole page.

  it("returns null for a message with the v1 version prefix", () => {
    // A zero-signature envelope whose message starts with the versioned
    // prefix 0x81 (version 1): deserialization asserts version 0, throws,
    // and the boundary converts it to null.
    const bytes = Buffer.concat([Buffer.from([0x00]), Buffer.from([0x81])]);
    const raw: RawTransaction = {
      transaction: [bytes.toString("base64"), "base64"],
      meta: {},
    };
    expect(decodeRawTransaction(raw)).toBeNull();
  });
});

describe("decodeRawTransaction version-1 transactions (SIMD-0385)", () => {
  // v1 activates on mainnet (SIMD-0385, announced for 2026-09-09; the
  // on-chain gate account records the true date). The bundled @solana/web3.js cannot
  // build or deserialize v1 messages (its deserializer asserts version 0),
  // so the envelope is parsed here per the SIMD and these tests pin every
  // field against REAL chain bytes rather than a hand-modeled shape.
  //
  // The fixture is a genuine devnet v1 transaction, signature
  // 3bXSKQ8DKAphwBF6DNbNoSzm9YWcmzMRN7Lz1jKs7AxEwhXA5NFtX6VNfWR6oy4LKDTwMnrm6RsijSeY4CwFdVeu
  // (block 495676584, success), fetched 2026-09-09 from
  // api.devnet.solana.com with maxSupportedTransactionVersion: 1 and kept
  // byte-for-byte in the getTransaction(base64) response shape. Its one
  // instruction is a compute-budget style op, so it must decode cleanly
  // AND produce no fee rows: an unrelated v1 transaction is not revenue.

  const REAL_V1_BASE64 =
    "gQEAAQwAAABZrn9Geyy9QOyQBlOi5POqdxw3lJ789VaPIeuAHVOy8QEDUqHvuOWhBkVUFQrt+G3XhJZCwpfE/NeVgktJghRKPjLze4W/dXluLiYNnl29YfRnmbkQ4yo2Nvk1Ei319ZiWnM5S8s5diwsp/V9N7L1deOZqhkue15uANDp/kdfN7/jHwFwVAAAAEAACARIAARY4/h1NIL8lJwAAAAAAAAAABIHOjW5o9tgS9W0eqKzf0ajmbl/fCnfUEsXpYHLPdsvdJ0fBGlaGNAfEO6u8Sy9f5PUxXWW/nI9ldj5EUhnnFgY=";
  const REAL_V1_BLOCK_TIME = 1788965346;
  const REAL_V1_ADDRESSES = [
    "6ZZecuC9M7khPZzZZSN8o4vpa2bds6cFJiCSziVVf7e9",
    "HPTKEmtGSTdAmnZUkTtMqr6VEQDgMrGmi4xiWgVA5JKu",
    "EtQM4CYjv2rutiBkD4FDj5zFaPkxfQ9og6g2rzdu5hY2",
  ];

  function realV1Raw(overrides: Partial<RawTransaction> = {}): RawTransaction {
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
  function buildV1RepairRaw(opts: {
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
      payloads.push(...ix.accountIndexes.map((a) => Buffer.from([a])), ix.data);
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

  it("decodes a real v1 transaction byte-for-byte (chain fixture)", () => {
    const decoded = decodeRawTransaction(realV1Raw());
    expect(decoded).not.toBeNull();
    expect(decoded!.blockTime).toBe(REAL_V1_BLOCK_TIME);
    expect(decoded!.accountKeys).toEqual(REAL_V1_ADDRESSES);
    expect(decoded!.instructions).toEqual([
      {
        programId: "EtQM4CYjv2rutiBkD4FDj5zFaPkxfQ9og6g2rzdu5hY2",
        accountPubkeys: ["HPTKEmtGSTdAmnZUkTtMqr6VEQDgMrGmi4xiWgVA5JKu"],
        data: new Uint8Array(Buffer.from("1638fe1d4d20bf2527000000000000000004", "hex")),
      },
    ]);
  });

  it("extracts no rows from an unrelated v1 transaction (no false positives)", () => {
    const rows = feeRowsFromRawTransactions(
      [{ signature: "real-devnet-v1", raw: realV1Raw() }],
      FEE_WALLET
    );
    expect(rows).toEqual([]);
  });

  it("extracts a fee from a hand-built v1 repair transaction", () => {
    const raw = buildV1RepairRaw({ feeLamports: 20_392 });
    const rows = feeRowsFromRawTransactions(
      [{ signature: "v1-repair", raw }],
      FEE_WALLET
    );
    expect(rows).toEqual([
      { signature: "v1-repair", blockTime: BLOCK_TIME, lamports: 20_392, onePercentMatch: true },
    ]);
  });

  it("returns null when a v1 envelope is truncated mid-addresses", () => {
    const bytes = Buffer.from(REAL_V1_BASE64, "base64");
    const raw = realV1Raw({
      transaction: [bytes.subarray(0, 100).toString("base64"), "base64"],
    });
    expect(decodeRawTransaction(raw)).toBeNull();
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

describe("rpcCall timeout (stubbed hanging fetch)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a hung RPC call and surfaces the honest network error", async () => {
    // A pathological provider/connection can leave a fetch pending far
    // longer than the UI expects. Every ledger RPC call is bounded by an
    // abort timer; the hang must become LedgerFetchError("network")
    // (the page's honest error state), never an eternal "Reading the
    // chain...". External audit 2026-09-02 finding #7.
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted"))
            );
          })
      )
    );

    const page = fetchFeeLedgerPage("https://rpc.example", FEE_WALLET);
    // Attach the rejection handler BEFORE advancing the clock: with fake
    // timers the rejection lands mid-advance, and an unattached instant
    // trips vitest's unhandled-rejection tracking even though the very
    // next line asserts it.
    const settled = expect(page).rejects.toBeInstanceOf(LedgerFetchError);
    await vi.advanceTimersByTimeAsync(31_000);
    await settled;
    await expect(page).rejects.toMatchObject({ kind: "network" });
  });
});

describe("per-transaction retry (stubbed transient RPC failure)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries one transient transaction-fetch failure instead of failing the page", async () => {
    // External audit finding #6: a single 500 on one of the page's
    // getTransaction calls used to fail the whole page fetch. One
    // bounded retry keeps a blip from hiding an otherwise readable
    // ledger; the sibling test pins that a persistent failure still
    // surfaces as the honest page error (never a silently dropped row).
    const raw = buildLegacyRaw([
      closeIx(),
      systemTransfer(new PublicKey(FEE_WALLET), 20_392),
    ]).raw;
    let txCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body)) as {
          method: string;
        };
        if (body.method === "getSignaturesForAddress") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              result: [{ signature: "s-1", blockTime: BLOCK_TIME }],
            }),
          };
        }
        txCalls += 1;
        if (txCalls === 1) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ result: raw }) };
      })
    );

    const page = await fetchFeeLedgerPage("https://rpc.example", FEE_WALLET);
    expect(page.rows.map((r) => r.signature)).toEqual(["s-1"]);
    expect(page.rows[0].lamports).toBe(20_392);
    expect(txCalls).toBe(2);
  });

  it("still fails the page honestly when the failure persists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "getSignaturesForAddress") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              result: [{ signature: "s-1", blockTime: BLOCK_TIME }],
            }),
          };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      })
    );
    await expect(
      fetchFeeLedgerPage("https://rpc.example", FEE_WALLET)
    ).rejects.toBeInstanceOf(LedgerFetchError);
  });
});

describe("decodeRawTransaction v1 property tests (fast-check)", () => {
  // The v1 decoder is a hand-rolled binary parser over network-derived
  // bytes. Two fixtures pin two cases; properties pin the space:
  // arbitrary bytes must never throw (the null-on-garbage contract),
  // every spec-valid envelope must round-trip exactly (the property
  // that would have caught the headers-first payload bug on day one),
  // and truncation must behave exactly as the contract claims.

  /** A spec-valid v1 envelope assembled per SIMD-0385. Returns the
   *  wire bytes, the offset where the (unread) signature tail starts,
   *  and the address list for round-trip comparison. */
  function buildV1Envelope(params: {
    addresses: PublicKey[];
    configMask: number;
    numRequiredSignatures: number;
    instructions: { programIndex: number; accountIndexes: number[]; data: Uint8Array }[];
  }): { bytes: Buffer; payloadEnd: number; addressStrings: string[] } {
    const parts: Buffer[] = [
      Buffer.from([0x81]),
      Buffer.from([params.numRequiredSignatures, 0, 0]),
      Buffer.from([params.configMask, 0, 0, 0]),
      Buffer.alloc(32, 9), // lifetime specifier
      Buffer.from([params.instructions.length]),
      Buffer.from([params.addresses.length]),
      ...params.addresses.map((k) => k.toBuffer()),
    ];
    if (params.configMask === 0x0c) {
      const cuLimit = Buffer.alloc(4);
      cuLimit.writeUInt32LE(1_400_000);
      const dataLimit = Buffer.alloc(4);
      dataLimit.writeUInt32LE(1_048_576);
      parts.push(cuLimit, dataLimit);
    }
    const headers: Buffer[] = [];
    const payloads: Buffer[] = [];
    for (const ix of params.instructions) {
      headers.push(Buffer.from([ix.programIndex, ix.accountIndexes.length]));
      const len = Buffer.alloc(2);
      len.writeUInt16LE(ix.data.length);
      headers.push(len);
      payloads.push(
        ...ix.accountIndexes.map((a) => Buffer.from([a])),
        Buffer.from(ix.data)
      );
    }
    parts.push(...headers, ...payloads);
    const beforeSignatures = Buffer.concat(parts);
    const bytes = Buffer.concat([
      beforeSignatures,
      Buffer.alloc(params.numRequiredSignatures * 64),
    ]);
    return {
      bytes,
      payloadEnd: beforeSignatures.length,
      addressStrings: params.addresses.map((k) => k.toBase58()),
    };
  }

  const envelopeArb = fc
    .record({
      addresses: fc.array(
        fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => new PublicKey(Uint8Array.from(b))),
        { minLength: 1, maxLength: 6 }
      ),
      configMask: fc.constantFrom(0, 0x0c),
      numRequiredSignatures: fc.integer({ min: 1, max: 2 }),
      instructions: fc.array(
        fc.record({
          programIndex: fc.integer({ min: 0, max: 5 }),
          accountIndexes: fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 3 }),
          data: fc.uint8Array({ minLength: 0, maxLength: 40 }),
        }),
        { minLength: 1, maxLength: 4 }
      ),
    })
    .filter(
      (p) =>
        p.numRequiredSignatures <= p.addresses.length &&
        p.instructions.every((ix) => ix.programIndex < p.addresses.length) &&
        p.instructions.every((ix) => ix.accountIndexes.every((a) => a < p.addresses.length))
    );

  it("never throws on arbitrary bytes; non-null output is always well-formed", () => {
    const shapeCheck = (decoded: ReturnType<typeof decodeRawTransaction>) => {
      if (decoded === null) return;
      expect(Array.isArray(decoded.instructions)).toBe(true);
      expect(Array.isArray(decoded.accountKeys)).toBe(true);
      for (const key of decoded.accountKeys) {
        expect(() => new PublicKey(key)).not.toThrow();
      }
    };
    // Plain garbage mostly exercises the legacy path; the biased
    // variant (0x81 prefix) exercises the v1 parser on noise.
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 600 }), (bytes) => {
        shapeCheck(
          decodeRawTransaction({ transaction: [Buffer.from(bytes).toString("base64"), "base64"], meta: {} })
        );
      }),
      { numRuns: 500 }
    );
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 600 }), (bytes) => {
        const prefixed = new Uint8Array([0x81, ...bytes]);
        shapeCheck(
          decodeRawTransaction({ transaction: [Buffer.from(prefixed).toString("base64"), "base64"], meta: {} })
        );
      }),
      { numRuns: 500 }
    );
  });

  it("round-trips every spec-valid envelope exactly", () => {
    fc.assert(
      fc.property(envelopeArb, (params) => {
        const { bytes, addressStrings } = buildV1Envelope(params);
        const decoded = decodeRawTransaction({
          transaction: [bytes.toString("base64"), "base64"],
          meta: { err: null, loadedAddresses: { readonly: [], writable: [] }, innerInstructions: [] },
        });
        expect(decoded).not.toBeNull();
        expect(decoded!.accountKeys).toEqual(addressStrings);
        expect(decoded!.instructions).toHaveLength(params.instructions.length);
        decoded!.instructions.forEach((ix, i) => {
          const generated = params.instructions[i];
          expect(ix.programId).toBe(addressStrings[generated.programIndex]);
          expect(ix.accountPubkeys).toEqual(
            generated.accountIndexes.map((a) => addressStrings[a])
          );
          expect(ix.data).toEqual(new Uint8Array(generated.data));
        });
      }),
      { numRuns: 250 }
    );
  });

  it("truncating before the payload end is null; cutting into the unread signature tail still decodes", () => {
    fc.assert(
      fc.property(
        envelopeArb,
        fc.integer({ min: 0, max: 500 }),
        (params, cutBias) => {
          const { bytes, payloadEnd } = buildV1Envelope(params);
          const cut = Math.round((cutBias / 500) * bytes.length);
          const raw: RawTransaction = {
            transaction: [bytes.subarray(0, cut).toString("base64"), "base64"],
            meta: {},
          };
          const decoded = decodeRawTransaction(raw);
          if (cut < payloadEnd) {
            expect(decoded).toBeNull();
          } else {
            // Everything the decoder reads survives; the signature
            // tail is never touched, so the envelope still parses.
            expect(decoded).not.toBeNull();
            expect(decoded!.accountKeys).toHaveLength(params.addresses.length);
          }
        }
      ),
      { numRuns: 250 }
    );
  });
});
