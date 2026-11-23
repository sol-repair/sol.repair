/**
 * Tests for the dust burn-and-close lib (docs/dust-zeroing-spec-draft.md
 * Revision 1): the selector's eligibility items, the fresh-gate
 * evaluator, and the burn-then-close builder. The gate shares
 * unwrapNative's account read, which its own suite pins; here the
 * burn-specific rules are what must be honest.
 */

import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createBurnInstruction,
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import {
  ALREADY_EMPTY_COPY,
  BURN_GATE_ABORT_COPY,
  MAX_BURN_PAIRS_PER_TX,
  buildBurnDustInstructions,
  buildBatchedBurnDustInstructions,
  evaluateBurnGate,
  selectBurnableDustAccounts,
  sumFloorFeeLamports,
  type BatchedBurnCandidate,
} from "../src/lib/solana/burnDust";
import { chunkInstructions } from "../src/lib/solana/transactions";
import type { ScanResult, SkippedAccount } from "../src/lib/solana/tokenAccounts";

const OWNER = Keypair.generate();
const NATIVE_MINT = "So11111111111111111111111111111111111111112";

function dustEntry(over: Partial<SkippedAccount> = {}): SkippedAccount {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    reason: "holds a token balance",
    program: "spl",
    cause: "funded",
    balance: "5000",
    decimals: 6,
    lamports: 2039280,
    nativeStatus: "non-native",
    ...over,
  };
}

function scanWith(entries: SkippedAccount[]): ScanResult {
  return {
    totalAccounts: entries.length,
    eligibleAccounts: [],
    recoverableLamports: 0n,
    skippedAccounts: entries,
  };
}

describe("selectBurnableDustAccounts eligibility", () => {
  it("offers a funded non-native account with complete evidence", () => {
    const out = selectBurnableDustAccounts(scanWith([dustEntry()]));
    expect(out).toHaveLength(1);
    expect(out[0].amountAtScan).toBe("5000");
    expect(out[0].decimals).toBe(6);
    expect(out[0].lamports).toBe(2039280);
  });

  it("excludes a frozen funded account (the on-chain Burn rejects frozen)", () => {
    const out = selectBurnableDustAccounts(
      scanWith([dustEntry({ frozen: true })])
    );
    expect(out).toHaveLength(0);
  });

  it("excludes a wrapped-SOL account (the G.3 unwrap flow owns native)", () => {
    const out = selectBurnableDustAccounts(
      scanWith([dustEntry({ mint: NATIVE_MINT, nativeStatus: "native" })])
    );
    expect(out).toHaveLength(0);
  });

  it("excludes an unknown native status (act only on confirmation)", () => {
    const out = selectBurnableDustAccounts(
      scanWith([dustEntry({ nativeStatus: "unknown" })])
    );
    expect(out).toHaveLength(0);
  });

  it("excludes a foreign close authority (the trailing close would fail)", () => {
    const out = selectBurnableDustAccounts(
      scanWith([dustEntry({ foreignCloseAuthority: true })])
    );
    expect(out).toHaveLength(0);
  });

  it("excludes entries with incomplete evidence (never invented)", () => {
    expect(
      selectBurnableDustAccounts(scanWith([dustEntry({ balance: undefined })]))
    ).toHaveLength(0);
    expect(
      selectBurnableDustAccounts(scanWith([dustEntry({ decimals: undefined })]))
    ).toHaveLength(0);
    expect(
      selectBurnableDustAccounts(scanWith([dustEntry({ lamports: undefined })]))
    ).toHaveLength(0);
    expect(
      selectBurnableDustAccounts(
        scanWith([dustEntry({ balance: "0" })])
      )
    ).toHaveLength(0);
  });

  it("carries delegate evidence without letting it block selection", () => {
    const delegate = Keypair.generate().publicKey.toBase58();
    const out = selectBurnableDustAccounts(
      scanWith([dustEntry({ delegated: true, delegate })])
    );
    expect(out).toHaveLength(1);
    expect(out[0].delegate).toBe(delegate);
  });

  it("never offers an empty (non-funded) entry", () => {
    const emptyClosable: SkippedAccount = {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      reason: "is a wrapped-SOL account",
      program: "spl",
      cause: "wrapped-sol",
      lamports: 15239280,
      nativeStatus: "native",
    };
    expect(selectBurnableDustAccounts(scanWith([emptyClosable]))).toHaveLength(
      0
    );
  });
});

describe("evaluateBurnGate", () => {
  const reviewedMint = Keypair.generate().publicKey.toBase58();

  function read(over: Record<string, unknown> = {}) {
    return {
      kind: "read",
      program: "spl",
      walletOwner: OWNER.publicKey.toBase58(),
      mint: reviewedMint,
      state: "initialized",
      nativeStatus: "non-native",
      amount: "5000",
      decimals: 6,
      lamports: 2039280,
      closeAuthority: null,
      delegate: null,
      ...over,
    } as const;
  }

  it("passes with the current balance, lamports, and decimals", () => {
    const verdict = evaluateBurnGate(read(), reviewedMint, OWNER.publicKey.toBase58());
    expect(verdict.kind).toBe("pass");
    if (verdict.kind === "pass") {
      expect(verdict.balanceBeforeAction).toBe("5000");
      expect(verdict.lamportsBeforeAction).toBe(2039280);
      expect(verdict.delegate).toBeNull();
    }
  });

  it("passes with drifted figures (Case B: consent uses current numbers)", () => {
    const verdict = evaluateBurnGate(
      read({ amount: "9000", lamports: 2074254 }),
      reviewedMint,
      OWNER.publicKey.toBase58()
    );
    expect(verdict.kind).toBe("pass");
    if (verdict.kind === "pass") {
      expect(verdict.balanceBeforeAction).toBe("9000");
    }
  });

  it("passes when a delegate is present (the owner can burn their own balance)", () => {
    const delegate = Keypair.generate().publicKey.toBase58();
    const verdict = evaluateBurnGate(
      read({ delegate }),
      reviewedMint,
      OWNER.publicKey.toBase58()
    );
    expect(verdict.kind).toBe("pass");
    if (verdict.kind === "pass") expect(verdict.delegate).toBe(delegate);
  });

  it("reports already-gone and already-empty as their own verdicts", () => {
    expect(evaluateBurnGate({ kind: "missing" }, reviewedMint, OWNER.publicKey.toBase58()).kind).toBe(
      "already-gone"
    );
    expect(
      evaluateBurnGate(read({ amount: "0" }), reviewedMint, OWNER.publicKey.toBase58())
        .kind
    ).toBe("already-empty");
  });

  it("aborts on frozen, foreign owner, foreign close authority, and mint mismatch", () => {
    const frozen = evaluateBurnGate(
      read({ state: "frozen" }),
      reviewedMint,
      OWNER.publicKey.toBase58()
    );
    expect(frozen).toEqual({ kind: "abort", reason: "frozen" });
    expect(BURN_GATE_ABORT_COPY.frozen).toContain("cannot be burned");

    const foreignOwner = evaluateBurnGate(
      read({ walletOwner: Keypair.generate().publicKey.toBase58() }),
      reviewedMint,
      OWNER.publicKey.toBase58()
    );
    expect(foreignOwner).toEqual({ kind: "abort", reason: "foreign-owner" });

    const foreignClose = evaluateBurnGate(
      read({ closeAuthority: Keypair.generate().publicKey.toBase58() }),
      reviewedMint,
      OWNER.publicKey.toBase58()
    );
    expect(foreignClose).toEqual({
      kind: "abort",
      reason: "foreign-close-authority",
    });

    const mintMismatch = evaluateBurnGate(
      read({ mint: Keypair.generate().publicKey.toBase58() }),
      reviewedMint,
      OWNER.publicKey.toBase58()
    );
    expect(mintMismatch).toEqual({ kind: "abort", reason: "mint-mismatch" });
  });

  it("aborts when the live read says native (the unwrap flow owns native)", () => {
    const verdict = evaluateBurnGate(
      read({ nativeStatus: "native" }),
      reviewedMint,
      OWNER.publicKey.toBase58()
    );
    expect(verdict).toEqual({ kind: "abort", reason: "native-status" });
  });

  it("names a rescan path in the already-empty copy", () => {
    expect(ALREADY_EMPTY_COPY).toContain("Nothing was signed");
  });
});

describe("buildBurnDustInstructions", () => {
  it("builds burn (tag 8) then closeAccount (tag 9), destroying the whole reviewed balance", () => {
    const account = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const candidate = {
      pubkey: account.toBase58(),
      mint: mint.toBase58(),
      program: "spl" as const,
      lamports: 2039280,
      amountAtScan: "5000",
      decimals: 6,
      amountBeforeAction: "7500",
    };
    const instructions = buildBurnDustInstructions(
      candidate,
      OWNER.publicKey
    );
    expect(instructions).toHaveLength(2);
    // Burn: data[0] = 8, amount u64 LE at bytes 1..9 === 7500.
    const burn = instructions[0];
    expect(burn.data[0]).toBe(8);
    const amount = burn.data.readBigUInt64LE(1);
    expect(amount).toBe(7500n);
    expect(burn.keys[0].pubkey.equals(account)).toBe(true);
    expect(burn.keys[1].pubkey.equals(mint)).toBe(true);
    expect(burn.keys[2].pubkey.equals(OWNER.publicKey)).toBe(true);
    expect(burn.keys[2].isSigner).toBe(true);
    // CloseAccount: data[0] = 9, destination and authority are the owner.
    const close = instructions[1];
    expect(close.data[0]).toBe(9);
    expect(close.keys[0].pubkey.equals(account)).toBe(true);
    expect(close.keys[1].pubkey.equals(OWNER.publicKey)).toBe(true);
    expect(close.keys[2].pubkey.equals(OWNER.publicKey)).toBe(true);
  });

  it("targets Token-2022 for a token-2022 candidate", () => {
    const candidate = {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      program: "token-2022" as const,
      lamports: 2039280,
      amountAtScan: "1",
      decimals: 0,
      amountBeforeAction: "1",
    };
    const instructions = buildBurnDustInstructions(
      candidate,
      OWNER.publicKey
    );
    const tokenzQd = new PublicKey(
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    );
    expect(instructions[0].programId.equals(tokenzQd)).toBe(true);
    expect(instructions[1].programId.equals(tokenzQd)).toBe(true);
  });

  it("refuses a zero reviewed balance (nothing to burn)", () => {
    const candidate = {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      program: "spl" as const,
      lamports: 2039280,
      amountAtScan: "0",
      decimals: 6,
      amountBeforeAction: "0",
    };
    expect(() =>
      buildBurnDustInstructions(candidate, OWNER.publicKey)
    ).toThrow(/nothing to burn/);
  });
});

/* ------------------------------------------------------------------ */
/* The mint-side burn blockers (audit M2, 2026-10)                      */
/* ------------------------------------------------------------------ */

describe("evaluateBurnGate mint blockers", () => {
  const reviewedMint = Keypair.generate().publicKey.toBase58();

  function read(over: Record<string, unknown> = {}) {
    return {
      kind: "read",
      program: "token-2022",
      walletOwner: OWNER.publicKey.toBase58(),
      mint: reviewedMint,
      state: "initialized",
      nativeStatus: "non-native",
      amount: "5000",
      decimals: 6,
      lamports: 2039280,
      closeAuthority: null,
      delegate: null,
      ...over,
    } as const;
  }

  it("passes with a clear mint read and unchanged figures", () => {
    const verdict = evaluateBurnGate(
      read(),
      reviewedMint,
      OWNER.publicKey.toBase58(),
      { status: "clear" }
    );
    expect(verdict.kind).toBe("pass");
    if (verdict.kind === "pass") {
      expect(verdict.balanceBeforeAction).toBe("5000");
      expect(verdict.lamportsBeforeAction).toBe(2039280);
    }
  });

  it("passes unchanged when no mint read is supplied (classic path)", () => {
    const verdict = evaluateBurnGate(
      read(),
      reviewedMint,
      OWNER.publicKey.toBase58()
    );
    expect(verdict.kind).toBe("pass");
  });

  it("aborts with the matching reason per blocker", () => {
    for (const [blocker, reason] of [
      ["paused", "mint-paused"],
      ["permissioned-burn", "mint-permissioned"],
      ["confidential-mint-burn", "mint-confidential"],
    ] as const) {
      const verdict = evaluateBurnGate(
        read(),
        reviewedMint,
        OWNER.publicKey.toBase58(),
        { status: "blocked", blocker }
      );
      expect(verdict).toEqual({ kind: "abort", reason });
    }
  });

  it("aborts conservatively when the mint read is unreadable", () => {
    const verdict = evaluateBurnGate(
      read(),
      reviewedMint,
      OWNER.publicKey.toBase58(),
      { status: "unreadable" }
    );
    expect(verdict).toEqual({ kind: "abort", reason: "mint-unreadable" });
    expect(BURN_GATE_ABORT_COPY["mint-unreadable"]).toContain(
      "extensions could not be read"
    );
  });

  it("carries the approved sentence for each mint abort", () => {
    expect(BURN_GATE_ABORT_COPY["mint-paused"]).toBe(
      "This mint is paused. Only its authority can unpause it. Nothing was signed."
    );
    expect(BURN_GATE_ABORT_COPY["mint-permissioned"]).toBe(
      "This mint requires its own burn authority to approve any burn. SOL.REPAIR cannot burn it. Nothing was signed."
    );
    expect(BURN_GATE_ABORT_COPY["mint-confidential"]).toBe(
      "This mint uses confidential burning, which this tool does not support. Nothing was signed."
    );
  });

  it("keeps every existing account abort ahead of the mint checks (drift policy unchanged)", () => {
    // The account-drift and abort behavior must be bit-for-bit today's:
    // account-side verdicts decide first, mint checks only convert a
    // would-be pass.
    const frozen = evaluateBurnGate(
      read({ state: "frozen" }),
      reviewedMint,
      OWNER.publicKey.toBase58(),
      { status: "blocked", blocker: "paused" }
    );
    expect(frozen).toEqual({ kind: "abort", reason: "frozen" });

    const drifted = evaluateBurnGate(
      read({ amount: "9000", lamports: 2074254 }),
      reviewedMint,
      OWNER.publicKey.toBase58(),
      { status: "blocked", blocker: "paused" }
    );
    // Drift still passes the account side; the mint blocker aborts.
    expect(drifted).toEqual({ kind: "abort", reason: "mint-paused" });

    const empty = evaluateBurnGate(
      read({ amount: "0" }),
      reviewedMint,
      OWNER.publicKey.toBase58(),
      { status: "blocked", blocker: "paused" }
    );
    expect(empty.kind).toBe("already-empty");
  });
});

describe("the batched burn-and-close (owner decision 2026-11-22)", () => {
  const RENTS = [1_488_440, 1_513_840, 2_039_280];

  function batchCandidate(program: "spl" | "token-2022", i: number): BatchedBurnCandidate {
    return {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      program,
      lamports: RENTS[i % RENTS.length],
      amountAtScan: `${1000 + i}`,
      decimals: 6,
      amountBeforeAction: `${1000 + i}`,
      lamportsBeforeAction: RENTS[i % RENTS.length],
    };
  }

  function batchOf(n: number): BatchedBurnCandidate[] {
    return Array.from({ length: n }, (_, i) =>
      batchCandidate(i % 4 === 3 ? "token-2022" : "spl", i)
    );
  }

  /** Offline serialized size of one batched transaction. The fake
   *  blockhash is a stand-in 32 bytes; the wire length is key-value
   *  independent, so the pins are exact byte counts. */
  function serializedSize(candidates: BatchedBurnCandidate[], walletAppendCount = 0): number {
    const ixs = buildBatchedBurnDustInstructions(candidates, OWNER.publicKey, true);
    const COMPUTE_BUDGET = new PublicKey(
      "ComputeBudget111111111111111111111111111111"
    );
    const appended = Array.from(
      { length: walletAppendCount },
      () =>
        new TransactionInstruction({
          programId: COMPUTE_BUDGET,
          keys: [],
          data: Buffer.from([0x02, 0x40, 0x0d, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00]),
        })
    );
    const tx = new Transaction({
      feePayer: OWNER.publicKey,
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    });
    tx.add(...ixs, ...appended);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  }

  it("pins all four measured size cells at the cap (E425)", () => {
    const plain = Array.from({ length: 9 }, (_, i) => batchCandidate("spl", i));
    const mixed = batchOf(9); // i % 4 === 3 rides Token-2022: one extra program key
    // Plain 9 pairs + the summed fee transfer: 1,021 bytes, margin 211.
    expect(serializedSize(plain)).toBe(1_021);
    // Mixed SPL + Token-2022 (one extra program key): 1,053, margin 179.
    expect(serializedSize(mixed)).toBe(1_053);
    // Plus the E421 wire's measured wallet append (4 keyless
    // instructions, 80 bytes): plain 1,101 (margin 131); mixed 1,133
    // (margin 99) - THE WORST MEASURED SHAPE, and its margin clears
    // the stated 69-byte floor, so the cap holds uniformly and mixed
    // chunks need no lower cap.
    expect(serializedSize(plain, 4)).toBe(1_101);
    const worst = serializedSize(mixed, 4);
    expect(worst).toBe(1_133);
    expect(1232 - worst).toBeGreaterThanOrEqual(69);
  });

  it("keeps the derivation honest: the raw maximum is 11 pairs, 12 overflows", () => {
    // Beyond the cap this is a fact about the packet limit, not a
    // product choice, so this pin builds RAW pairs (the capped builder
    // refuses more than 9 by design): 11 plain pairs fit (1,193
    // bytes), 12 refuse in the serializer itself (1,279 > 1232).
    const rawPairs = (n: number) =>
      Array.from({ length: n }, () => {
        const account = Keypair.generate().publicKey;
        const mint = Keypair.generate().publicKey;
        return [
          createBurnInstruction(account, mint, OWNER.publicKey, 1000n, [], TOKEN_PROGRAM_ID),
          createCloseAccountInstruction(account, OWNER.publicKey, OWNER.publicKey, [], TOKEN_PROGRAM_ID),
        ];
      }).flat();
    const sizeOf = (n: number) => {
      const tx = new Transaction({
        feePayer: OWNER.publicKey,
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1,
      });
      tx.add(
        ...rawPairs(n),
        SystemProgram.transfer({
          fromPubkey: OWNER.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        })
      );
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    };
    expect(sizeOf(11)).toBe(1_193);
    expect(() => sizeOf(12)).toThrow();
  });

  it("refuses to build a chunk over the cap", () => {
    expect(() =>
      buildBatchedBurnDustInstructions(batchOf(10), OWNER.publicKey, true)
    ).toThrow(/at most 9/);
  });

  it("refuses an empty batch and a zero reviewed balance", () => {
    expect(() =>
      buildBatchedBurnDustInstructions([], OWNER.publicKey, true)
    ).toThrow(/at least one/);
    const zero = { ...batchCandidate("spl", 0), amountBeforeAction: "0" };
    expect(() =>
      buildBatchedBurnDustInstructions([zero], OWNER.publicKey, true)
    ).toThrow(/nothing to burn/);
  });

  it("rides the summed fee transfer LAST with the sum of per-account floors", () => {
    const candidates = batchOf(9);
    const ixs = buildBatchedBurnDustInstructions(candidates, OWNER.publicKey, true);
    // 9 pairs = 18 token-program instructions, then exactly one transfer.
    expect(ixs).toHaveLength(19);
    const last = ixs[ixs.length - 1];
    expect(last.programId.equals(SystemProgram.programId)).toBe(true);
    // batchOf(9) rents cycle 1,488,440 / 1,513,840 / 2,039,280, so 3 of
    // each: 3 x 14,884 + 3 x 15,138 + 3 x 20,392 = 151,242. The
    // floor-of-total reading would be 151,244; the batch charges the
    // per-account sum, byte-identical to nine single burns.
    const expected = 3n * 14_884n + 3n * 15_138n + 3n * 20_392n;
    expect(sumFloorFeeLamports(candidates)).toBe(expected);
    expect(sumFloorFeeLamports(candidates)).toBe(151_242n);
    expect(last.data).toHaveLength(12);
    expect(Number(last.data.readBigUInt64LE(4))).toBe(151_242);
    // Every pair is [burn tag 8, close tag 9] for its own program.
    for (let i = 0; i < 9; i++) {
      const burn = ixs[2 * i];
      const close = ixs[2 * i + 1];
      expect(burn.data[0]).toBe(8);
      expect(close.data[0]).toBe(9);
      const wantProgram =
        candidates[i].program === "token-2022"
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;
      expect(burn.programId.equals(wantProgram)).toBe(true);
      expect(close.programId.equals(wantProgram)).toBe(true);
      // Burn amount = the gate's balance, exact base units.
      const amount = burn.data.readBigUInt64LE(1);
      expect(amount).toBe(BigInt(candidates[i].amountBeforeAction));
    }
  });

  it("skips the fee when the page's feeReady is false, and never emits an empty transfer", () => {
    const candidates = batchOf(2);
    expect(buildBatchedBurnDustInstructions(candidates, OWNER.publicKey, false)).toHaveLength(4);
    const zeroRent = candidates.map((c) => ({ ...c, lamports: 0, lamportsBeforeAction: 0 }));
    // lamports 0 -> floor 0 -> no fee instruction at all
    expect(buildBatchedBurnDustInstructions(zeroRent, OWNER.publicKey, true)).toHaveLength(4);
  });

  it("computes the fee from the GATE's lamports, never the scan's stale figure (the devnet-walk finding)", () => {
    // The devnet rehearsal walk caught this: a Token-2022 account born
    // at extension-era rent 1,513,840 was charged floor(1%) of the
    // scan's 1,488,440 because the builder read the wrong field. The
    // fee base is what the close RETURNS at gate time: sum of floors
    // of [1,513,840, 1,488,440, 1,488,440] = 15,138 + 14,884 + 14,884
    // = 44,906, not 44,652.
    const [a, b, c] = [0, 1, 2].map((i) => batchCandidate(i === 0 ? "token-2022" : "spl", i));
    const drifted = [
      { ...a, lamports: 1_488_440, lamportsBeforeAction: 1_513_840 },
      { ...b, lamports: 1_488_440, lamportsBeforeAction: 1_488_440 },
      { ...c, lamports: 1_488_440, lamportsBeforeAction: 1_488_440 },
    ];
    expect(
      sumFloorFeeLamports(drifted.map((d) => ({ lamports: d.lamportsBeforeAction })))
    ).toBe(44_906n);
    const ixs = buildBatchedBurnDustInstructions(drifted, OWNER.publicKey, true);
    const fee = ixs[ixs.length - 1];
    expect(fee.programId.equals(SystemProgram.programId)).toBe(true);
    expect(Number(fee.data.readBigUInt64LE(4))).toBe(44_906);
  });

  it("chunks N candidates into ceil(N / 9) approvals (47 -> 6, the honest count)", () => {
    expect(MAX_BURN_PAIRS_PER_TX).toBe(9);
    expect(chunkInstructions(batchOf(47), MAX_BURN_PAIRS_PER_TX)).toHaveLength(6);
    expect(chunkInstructions(batchOf(20), MAX_BURN_PAIRS_PER_TX)).toHaveLength(3);
    const chunks = chunkInstructions(batchOf(47), MAX_BURN_PAIRS_PER_TX);
    expect(chunks.map((c) => c.length)).toEqual([9, 9, 9, 9, 9, 2]);
    // Order preserved: chunk k holds candidates 9k..9k+8.
    expect(chunks[0][0].pubkey).not.toBe(chunks[1][0].pubkey);
  });

  it("the close still binds destination and authority to the wallet (frozen binding unchanged)", () => {
    const candidates = batchOf(1);
    const ixs = buildBatchedBurnDustInstructions(candidates, OWNER.publicKey, true);
    const close = createCloseAccountInstruction(
      new PublicKey(candidates[0].pubkey),
      OWNER.publicKey,
      OWNER.publicKey,
      [],
      TOKEN_PROGRAM_ID
    );
    expect(ixs[1].programId.equals(close.programId)).toBe(true);
    expect(ixs[1].keys.map((k) => k.pubkey.toBase58())).toEqual(
      close.keys.map((k) => k.pubkey.toBase58())
    );
  });
});
