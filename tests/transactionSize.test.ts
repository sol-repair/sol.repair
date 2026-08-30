/**
 * Serialized transaction size guard.
 *
 * Solana transactions must fit the 1232-byte packet limit. The largest
 * intended batch is MAX_CLOSE_INSTRUCTIONS_PER_TX (20) closeAccount
 * instructions PLUS the 1% fee transfer, mixed across both token programs
 * (the implementation supports both in one batch). This test builds that
 * exact transaction with the production builders, signs it, and asserts
 * the real serialized size fits the limit.
 */

import { describe, expect, it } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";

import { buildCloseAccountInstructions } from "../src/lib/solana/closeAccounts";
import { buildFeeTransfer } from "../src/lib/solana/fees";
import {
  buildTransaction,
  MAX_CLOSE_INSTRUCTIONS_PER_TX,
} from "../src/lib/solana/transactions";
import type { ClosableAccount } from "../src/lib/solana/tokenAccounts";

/** The packet limit Solana validators enforce for a signed transaction. */
const PACKET_LIMIT = 1232;

function makeAccounts(count: number): ClosableAccount[] {
  return Array.from({ length: count }, (_, i) => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: 2039280,
    // Alternate programs so one batch exercises the mixed-program shape
    // the implementation claims to support.
    program: i % 2 === 0 ? "spl" : "token-2022",
  }));
}

// buildTransaction only reads getLatestBlockhash from the connection.
const fakeConnection = {
  getLatestBlockhash: async () => ({
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 1000,
  }),
} as unknown as Connection;

describe("transaction size", () => {
  it("largest intended batch (20 mixed closes + fee transfer) serializes under the packet limit", async () => {
    const owner = Keypair.generate();
    const accounts = makeAccounts(MAX_CLOSE_INSTRUCTIONS_PER_TX);
    expect(accounts.length).toBe(20);
    // Mixed shape: 10 classic, 10 Token-2022 in the same batch.
    expect(
      accounts.filter((a) => a.program === "spl").length
    ).toBe(10);
    expect(
      accounts.filter((a) => a.program === "token-2022").length
    ).toBe(10);

    const instructions = buildCloseAccountInstructions(accounts, owner.publicKey);

    // The fee must be part of the transaction being measured.
    const fee = buildFeeTransfer(owner.publicKey, accounts);
    expect(fee).not.toBeNull();
    instructions.push(fee!);
    expect(instructions.length).toBe(21);

    const transaction = await buildTransaction(
      fakeConnection,
      owner.publicKey,
      instructions
    );

    // Sign the way the wallet adapter would, then measure the real bytes.
    transaction.sign(owner);
    const serialized = transaction.serialize().length;

    expect(serialized).toBeLessThanOrEqual(PACKET_LIMIT);
  });
});
