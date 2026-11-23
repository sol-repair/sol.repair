// Operator tooling, shared by the two fee-ledger scripts (the anomaly
// bell and the weekly recovered-totals walk): the dual-arm conformance
// comparison, owner decision 2026-11-22 (the batched burn-and-close).
//
// This is deliberately NOT an import of src/lib/solana/feeLedger.ts:
// the bell's independence from the product code is the point (see the
// header of check-fee-ledger.mjs). What changed on 2026-11-22 is that
// the TWO SCRIPTS now share ONE helper between themselves instead of
// two inline copies of the same formula, so the two operator tools can
// never drift apart.
//
// The published rule has two honest readings of "1 percent, floored",
// and a fee matching EITHER is conforming, both compared EXACTLY:
//   arm 1, floorOfTotal: floor(1% of the batch's total rent) - the
//     rule every repair row has always satisfied;
//   arm 2, sumOfFloors:  the sum of each account's own floor(1%) -
//     the rule the batched burn-and-close charges, byte-identical to
//     what the same accounts cost burned one at a time.
// The arms differ by less than one lamport per account (at most k-1
// lamports on a k-account transaction; at the shipped batch cap of 9
// that bound is 8 lamports). One lamport off BOTH arms flags: no
// tolerance, no slop. Every historical row conforms on arm 1 unchanged.

export function feeVerdictArms(perAccountRents) {
  const total = perAccountRents.reduce((acc, r) => acc + BigInt(r), 0n);
  return {
    floorOfTotal: (total * 1n) / 100n,
    sumOfFloors: perAccountRents.reduce((acc, r) => acc + BigInt(r) / 100n, 0n),
  };
}

/** Exact dual-arm conformance: true when the charged lamports equal
 *  either arm, false otherwise (a violation). */
export function feeConforms(lamports, perAccountRents) {
  const arms = feeVerdictArms(perAccountRents);
  const fee = BigInt(lamports);
  return fee === arms.floorOfTotal || fee === arms.sumOfFloors;
}
