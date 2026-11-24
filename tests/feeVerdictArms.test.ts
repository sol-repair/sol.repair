/**
 * Pins for the shared scripts-side verdict helper
 * (scripts/fee-verdict-arms.mjs), the dual-arm conformance comparison
 * used by the anomaly bell and the weekly recovered-totals walk (owner
 * decision 2026-11-22, the batched burn-and-close). Both arms are
 * EXACT: floor(1% of total rent) and the sum of per-account floors.
 * Historical rows conform on arm 1 unchanged; batched rows conform on
 * arm 2; one lamport off both arms flags. The helper is deliberately
 * scripts-side only, so these tests import it across the scripts/
 * boundary; src/ has its own TS copy pinned in feeLedger.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  feeConforms,
  feeRowStructureConforms,
  feeVerdictArms,
} from "../scripts/fee-verdict-arms.mjs";

describe("fee-verdict-arms (the dual-arm 1% rule)", () => {
  it("single-account rows: both arms agree, exact fee conforms, off-by-one flags", () => {
    const rents = [2_039_280];
    expect(feeVerdictArms(rents).floorOfTotal).toBe(20_392n);
    expect(feeVerdictArms(rents).sumOfFloors).toBe(20_392n);
    expect(feeConforms(20_392, rents)).toBe(true);
    expect(feeConforms(20_391, rents)).toBe(false);
    expect(feeConforms(20_393, rents)).toBe(false);
  });

  it("the recorded two-close repair fixture conforms on arm 1 unchanged (both arms agree there)", () => {
    // tests/feeLedger.test.ts's real devnet numbers: 1,856,000 +
    // 1,886,803, charged 37,428 = floor(total/100). The per-account
    // floors sum to the same figure here (18,560 + 18,868).
    const rents = [1_856_000, 1_886_803];
    const arms = feeVerdictArms(rents);
    expect(arms.floorOfTotal).toBe(37_428n);
    expect(arms.sumOfFloors).toBe(37_428n);
    expect(feeConforms(37_428, rents)).toBe(true);
  });

  it("a husked BurnNft return (rent = pre - post per account) conforms on arm 1", () => {
    // The E405 ruling's real figures: the return base 6,252,320,
    // charged 62,523. Reconstructed as unequal per-account returns.
    const rents = [5_974_080, 278_240];
    const arms = feeVerdictArms(rents);
    expect(arms.floorOfTotal).toBe(62_523n);
    expect(feeConforms(62_523, rents)).toBe(true);
  });

  it("batched rows with unequal rents conform on arm 2 only where they differ", () => {
    // SPL, SPL, Token-2022 rents from the graduated fixture: the two
    // arms differ by one lamport, and each arm's own fee conforms.
    const rents = [1_488_440, 1_513_840, 2_039_280];
    const arms = feeVerdictArms(rents);
    expect(arms.floorOfTotal).toBe(50_415n);
    expect(arms.sumOfFloors).toBe(50_414n);
    expect(feeConforms(50_415, rents)).toBe(true);
    expect(feeConforms(50_414, rents)).toBe(true);
  });

  it("a fee one lamport off BOTH arms flags (no tolerance, no slop)", () => {
    const rents = [1_488_440, 1_513_840, 2_039_280];
    expect(feeConforms(50_416, rents)).toBe(false); // arm 1 + 1
    expect(feeConforms(50_413, rents)).toBe(false); // arm 2 - 1
  });

  it("an inflated crafted transfer still flags on both arms", () => {
    // The historical anti-crafting case: rent 2,039,280 charged 100,000.
    expect(feeConforms(100_000, [2_039_280])).toBe(false);
  });

  it("a nine-account batch at the shipped cap: the arms differ by at most 8 lamports", () => {
    const rents = Array.from({ length: 9 }, () => 1_488_440);
    const arms = feeVerdictArms(rents);
    expect(arms.sumOfFloors).toBe(133_956n);
    expect(arms.floorOfTotal).toBe(133_959n);
    expect(feeConforms(133_956, rents)).toBe(true);
    expect(feeConforms(133_959, rents)).toBe(true);
    expect(Number(arms.floorOfTotal - arms.sumOfFloors)).toBeLessThanOrEqual(8);
  });
});

describe("the structural half of the fee rule (helper mirror)", () => {
  const facts = (specs: Array<[boolean, boolean]>) =>
    specs.map(([isInboundFeeTransfer, isValueMoving]) => ({
      isInboundFeeTransfer,
      isValueMoving,
    }));

  it("one transfer, nothing value-moving after: conforms", () => {
    // close, fee transfer
    expect(feeRowStructureConforms(facts([[false, true], [true, false]]))).toBe(true);
  });

  it("keyless and Lighthouse-style instructions after the transfer pass", () => {
    // close, fee transfer, keyless, lighthouse (1-acct assertion)
    expect(
      feeRowStructureConforms(
        facts([
          [false, true],
          [true, false],
          [false, false],
          [false, false],
        ])
      )
    ).toBe(true);
  });

  it("split fee transfers fail structurally even when the sum is exact", () => {
    const rents = [1_488_440, 1_488_440];
    const arms = feeVerdictArms(rents);
    expect(arms.floorOfTotal).toBe(29_768n);
    // two transfers of 14,884 each sum exactly - but there are TWO
    expect(feeConforms(29_768, rents)).toBe(true); // amount half passes
    expect(
      feeRowStructureConforms(
        facts([
          [false, true],
          [true, false],
          [true, false],
        ])
      )
    ).toBe(false); // structural half fails
  });

  it("a value-moving instruction riding after the transfer fails", () => {
    // close, fee transfer, trailing close (the E405 wallet-appended
    // close shape - value-moving, not keyless)
    expect(
      feeRowStructureConforms(
        facts([
          [false, true],
          [true, false],
          [false, true],
        ])
      )
    ).toBe(false);
  });

  it("the transfer riding BEFORE the closes fails", () => {
    // fee transfer first, then closes: the transfer is not last
    expect(
      feeRowStructureConforms(
        facts([
          [true, false],
          [false, true],
          [false, true],
        ])
      )
    ).toBe(false);
  });

  it("no fee transfer at all fails", () => {
    expect(feeRowStructureConforms(facts([[false, true]]))).toBe(false);
  });
});
