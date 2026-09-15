/**
 * Tests for the rent estimate used by the guide pages' calculator.
 *
 * The numbers must match what a real wallet sees. A standard 165-byte
 * token account is rent-exempt at 2,039,280 lamports on mainnet when
 * created before 2026-09-04, at 1,855,569 lamports after SIMD-0437
 * step 1 went live at epoch 1028, and at 1,488,440 lamports after the
 * second step-down (read from the chain 2026-09-14 at slot
 * 447,121,307). The guide pages are copy, but the math people
 * multiply out by hand has to be exact.
 */

import { describe, expect, it } from "vitest";

import {
  TOKEN_ACCOUNT_RENT_LAMPORTS_CURRENT,
  TOKEN_ACCOUNT_RENT_LAMPORTS_LEGACY,
  estimateRentRange,
  formatRentSol,
} from "../src/lib/rent";

describe("rent constants and estimates", () => {
  it("carries the verified mainnet rent-exempt minimums", () => {
    // DIRECTLY OBSERVED on mainnet via getMinimumBalanceForRentExemption(165):
    // 2,039,280 on 2026-09-02 and 2026-09-03, 1,855,569 on 2026-09-04 after
    // SIMD-0437 step 1 went live at epoch 1028, then 1,488,440 on 2026-09-14
    // after the second step-down.
    expect(TOKEN_ACCOUNT_RENT_LAMPORTS_LEGACY).toBe(2_039_280);
    expect(TOKEN_ACCOUNT_RENT_LAMPORTS_CURRENT).toBe(1_488_440);
  });

  it("returns the current-to-legacy range for an account count", () => {
    expect(estimateRentRange(1)).toEqual([1_488_440n, 2_039_280n]);
    expect(estimateRentRange(10)).toEqual([14_884_400n, 20_392_800n]);
    expect(estimateRentRange(30)).toEqual([44_653_200n, 61_178_400n]);
  });

  it("rejects counts that are not real account counts", () => {
    expect(estimateRentRange(0)).toBeNull();
    expect(estimateRentRange(-5)).toBeNull();
    expect(estimateRentRange(10.5)).toBeNull();
    expect(estimateRentRange(1_000_000)).toBeNull();
  });

  it("formats lamports as SOL the way the rest of the site does", () => {
    expect(formatRentSol(2_039_280n)).toBe("0.00203928");
    expect(formatRentSol(1_855_569n)).toBe("0.00185557");
    expect(formatRentSol(1_488_440n)).toBe("0.00148844");
    expect(formatRentSol(61_178_400n)).toBe("0.0611784");
    expect(formatRentSol(20_392_800n)).toBe("0.0203928");
  });
});
