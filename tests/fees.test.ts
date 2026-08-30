/**
 * Fixture tests for the fee logic in fees.ts.
 *
 * The expected amounts are not invented: they are the exact values
 * from real, chain-verified fee receipts: 20,392 from the classic
 * SPL self-test, 20,740 from the token-2022 self-test, 409,596 from
 * the 30-account devnet whale run. Receipt details live in the
 * operator's local logs.
 *
 * These tests run with the default devnet env, so the enabled-fee
 * path is what gets exercised. The mainnet failsafe branch (fee off
 * if the mainnet build ever points at the devnet recipient) depends
 * on baked build-time env and is not reachable from a unit test.
 */

import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import {
  buildFeeTransfer,
  feeAmountLamports,
  getFeeRecipient,
} from "../src/lib/solana/fees";
import type { ClosableAccount } from "../src/lib/solana/tokenAccounts";

function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

const OWNER = pk(1);

function account(
  seed: number,
  lamports: number,
  program: "spl" | "token-2022" = "spl"
): ClosableAccount {
  return {
    pubkey: pk(seed).toBase58(),
    mint: pk(seed + 100).toBase58(),
    lamports,
    program,
  };
}

describe("feeAmountLamports (receipt-verified values)", () => {
  it("one classic account: 2,039,280 rent -> 20,392 (sig 4GnC4yuZ)", () => {
    expect(feeAmountLamports([account(2, 2_039_280)])).toBe(20_392n);
  });

  it("one token-2022 account: 2,074,080 rent -> 20,740 (sig i7Riy8r8)", () => {
    expect(
      feeAmountLamports([account(3, 2_074_080, "token-2022")])
    ).toBe(20_740n);
  });

  it("the whale batch: 15 classic + 5 token-2022 -> 409,596 (sig fibhQ2VM)", () => {
    const batch = [
      ...Array.from({ length: 15 }, (_, i) => account(10 + i, 2_039_280)),
      ...Array.from({ length: 5 }, (_, i) =>
        account(30 + i, 2_074_080, "token-2022")
      ),
    ];
    expect(feeAmountLamports(batch)).toBe(409_596n);
  });

  it("floors to whole lamports: three classic accounts -> 61,178", () => {
    // 3 x 2,039,280 = 6,117,840; 1% is 61,178.4 -> floors to 61,178
    expect(
      feeAmountLamports([
        account(40, 2_039_280),
        account(41, 2_039_280),
        account(42, 2_039_280),
      ])
    ).toBe(61_178n);
  });

  it("empty batch -> 0", () => {
    expect(feeAmountLamports([])).toBe(0n);
  });
});

describe("buildFeeTransfer guards and shape", () => {
  it("returns null on an empty batch", () => {
    expect(buildFeeTransfer(OWNER, [])).toBeNull();
  });

  it("returns null when 1% floors to zero lamports", () => {
    // 99-lamport batch: 1% is 0.99, floors to 0, no instruction
    expect(buildFeeTransfer(OWNER, [account(50, 99)])).toBeNull();
  });

  it("builds a plain system transfer from the owner to the fee recipient", () => {
    const ix = buildFeeTransfer(OWNER, [account(51, 2_039_280)]);
    expect(ix).not.toBeNull();
    expect(ix!.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix!.keys[0].pubkey.equals(OWNER)).toBe(true);
    expect(ix!.keys[1].pubkey.equals(getFeeRecipient())).toBe(true);
    // system transfer data: u32 discriminator + u64 lamports, little endian
    const data = Buffer.from(ix!.data);
    expect(data.length).toBe(12);
    expect(data.readUInt32LE(0)).toBe(2);
    expect(data.readBigUInt64LE(4)).toBe(20_392n);
  });
});
