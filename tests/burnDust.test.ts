/**
 * Tests for the dust burn-and-close lib (docs/dust-zeroing-spec-draft.md
 * Revision 1): the selector's eligibility items, the fresh-gate
 * evaluator, and the burn-then-close builder. The gate shares
 * unwrapNative's account read, which its own suite pins; here the
 * burn-specific rules are what must be honest.
 */

import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  ALREADY_EMPTY_COPY,
  BURN_GATE_ABORT_COPY,
  buildBurnDustInstructions,
  evaluateBurnGate,
  selectBurnableDustAccounts,
} from "../src/lib/solana/burnDust";
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
