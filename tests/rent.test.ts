/**
 * Tests for the rent estimate used by the guide pages' calculator.
 *
 * The numbers must match what a real wallet sees: a standard 165-byte
 * token account is rent-exempt at 2,039,280 lamports on mainnet today.
 * The guide pages are copy, but the math people multiply out by hand
 * has to be exact.
 */

import { describe, expect, it } from "vitest";

import {
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  estimateRentLamports,
  formatRentSol,
} from "../src/lib/rent";

describe("rent constants and estimates", () => {
  it("carries the verified mainnet rent-exempt minimum for token accounts", () => {
    // DIRECTLY OBSERVED on mainnet 2026-09-02 and 2026-09-03 via
    // getMinimumBalanceForRentExemption(165). When the parked rent-copy
    // trigger fires, this constant and the guide copy move together.
    expect(TOKEN_ACCOUNT_RENT_LAMPORTS).toBe(2_039_280);
  });

  it("multiplies an account count into lamports", () => {
    expect(estimateRentLamports(1)).toBe(2_039_280n);
    expect(estimateRentLamports(10)).toBe(20_392_800n);
    expect(estimateRentLamports(30)).toBe(61_178_400n);
  });

  it("rejects counts that are not real account counts", () => {
    expect(estimateRentLamports(0)).toBeNull();
    expect(estimateRentLamports(-5)).toBeNull();
    expect(estimateRentLamports(10.5)).toBeNull();
    expect(estimateRentLamports(1_000_000)).toBeNull();
  });

  it("formats lamports as SOL the way the rest of the site does", () => {
    expect(formatRentSol(2_039_280n)).toBe("0.00203928");
    expect(formatRentSol(61_178_400n)).toBe("0.0611784");
    expect(formatRentSol(20_392_800n)).toBe("0.0203928");
  });
});
