/**
 * Tests for transaction assembly helpers in transactions.ts:
 * the batching cap and the network fee estimate. The cap numbers
 * come from the measured packet budget (see the module comments):
 * 20 closes per transaction with headroom for wallet-added
 * instructions.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_CLOSE_INSTRUCTIONS_PER_TX,
  chunkInstructions,
  estimateNetworkFee,
} from "../src/lib/solana/transactions";

describe("chunkInstructions", () => {
  it("empty list -> no chunks", () => {
    expect(chunkInstructions([])).toEqual([]);
  });

  it("one item -> one chunk", () => {
    expect(chunkInstructions(["a"])).toEqual([["a"]]);
  });

  it("exactly 20 items -> still one transaction", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(chunkInstructions(items)).toHaveLength(1);
  });

  it("21 items -> splits into two transactions", () => {
    const items = Array.from({ length: 21 }, (_, i) => i);
    const chunks = chunkInstructions(items);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(20);
    expect(chunks[1]).toHaveLength(1);
  });

  it("40 -> two, 41 -> three", () => {
    expect(
      chunkInstructions(Array.from({ length: 40 }, (_, i) => i))
    ).toHaveLength(2);
    expect(
      chunkInstructions(Array.from({ length: 41 }, (_, i) => i))
    ).toHaveLength(3);
  });

  it("preserves order across chunks", () => {
    const chunks = chunkInstructions([1, 2, 3, 4, 5, 6, 7], 3);
    expect(chunks).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ]);
  });

  it("throws on maxPerChunk below 1", () => {
    expect(() => chunkInstructions([1], 0)).toThrow();
  });

  it("default cap is the documented 20", () => {
    expect(MAX_CLOSE_INSTRUCTIONS_PER_TX).toBe(20);
    expect(
      chunkInstructions(Array.from({ length: 20 }, (_, i) => i)).length
    ).toBe(1);
  });
});

describe("estimateNetworkFee", () => {
  it("is the 5000 lamport base fee", () => {
    expect(estimateNetworkFee()).toBe(5000n);
  });
});
