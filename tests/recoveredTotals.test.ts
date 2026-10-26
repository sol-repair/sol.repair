import { describe, expect, it } from "vitest";

import { RECOVERED_TOTALS } from "@/lib/recoveredTotals";

/**
 * Shape pins on the generated recovered-to-date constant. The values
 * come from scripts/update-recovered-totals.mjs (the weekly bump); the
 * tests pin the SHAPE and the internal consistency, never the specific
 * numbers, so the Sunday bump cannot break the suite.
 */
describe("RECOVERED_TOTALS (generated constant)", () => {
  it("carries ISO dates, and nextUpdate is a Sunday strictly after asOf", () => {
    expect(RECOVERED_TOTALS.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(RECOVERED_TOTALS.nextUpdate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const asOf = new Date(`${RECOVERED_TOTALS.asOf}T00:00:00Z`);
    const next = new Date(`${RECOVERED_TOTALS.nextUpdate}T00:00:00Z`);
    expect(next.getUTCDay()).toBe(0); // Sunday
    expect(next.getTime()).toBeGreaterThan(asOf.getTime());
    const days = (next.getTime() - asOf.getTime()) / 86400000;
    expect(days).toBeLessThanOrEqual(7);
  });

  it("carries positive counts and a digit-string lamports figure", () => {
    expect(RECOVERED_TOTALS.wallets).toBeGreaterThan(0);
    expect(Number.isInteger(RECOVERED_TOTALS.wallets)).toBe(true);
    expect(RECOVERED_TOTALS.closes).toBeGreaterThan(0);
    expect(Number.isInteger(RECOVERED_TOTALS.closes)).toBe(true);
    expect(RECOVERED_TOTALS.lamportsFreed).toMatch(/^\d+$/);
  });

  it("preformats the SOL figure with the ledger's own convention", () => {
    const sol = (Number(RECOVERED_TOTALS.lamportsFreed) / 1e9)
      .toFixed(9)
      .replace(/0+$/, "")
      .replace(/\.$/, "");
    expect(RECOVERED_TOTALS.lamportsFreedSol).toBe(sol);
    expect(RECOVERED_TOTALS.lamportsFreedSol).not.toMatch(/^-/);
  });
});
