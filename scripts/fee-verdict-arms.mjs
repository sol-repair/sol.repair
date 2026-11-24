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

// The structural half of the fee rule (audit finding 3, escalated;
// owner ruling 2026-11-23, option e - value-inert tail): the fee is
// ONE transfer riding LAST. A fee-bearing transaction conforms
// structurally when exactly one inbound transfer to the fee wallet
// exists, positioned after every close/burn/BurnNft instruction, with
// nothing value-moving after it - nothing that moves lamports or
// destroys accounts. The value-moving set is the ONE unified
// definition across all three implementations (auditor round 3,
// 2026-11-24; the app ledger, the bell, and the weekly counter may
// differ in decoding but never in verdict): a system transfer to any
// destination, funded system account creation (CreateAccount and
// CreateAccountWithSeed), the nonce account's lamport-moving
// instructions (WithdrawNonceAccount and InitializeNonceAccount - IN
// per the explicit owner nonce ruling 2026-11-24; AdvanceNonce and
// AuthorizeNonceAccount are OUT, no lamports move), a token close, a
// token burn or BurnChecked (tag 15), and a Metaplex BurnNft.
// Exactly-one is counted in transfer INSTRUCTIONS regardless of
// amount (owner ruling 2026-11-24): a zero-lamport transfer to the
// fee wallet counts toward the one. Keyless wallet-appended
// instructions (compute budget) pass; third-party assertion
// instructions that move nothing (the Lighthouse security tool's
// checks, census 463 of 463) pass. Runs on OUTER instructions only:
// CPI closes are the BurnNft program's own business. Honest boundary,
// on the record: this polices the detectable lamport-movement and
// account-destruction shapes only, not arbitrary behavior of an
// upgradable third-party program; the wallet's pre-signature display
// remains the first line of defense.
//
// Mirrors the TS copy in src/lib/solana/feeLedger.ts
// (structuralConformance), the same deliberate two-implementation
// pattern as the rest of the operator tooling: scripts and product
// code agree on the rule, each written for its own decoding pipeline.

/**
 * @param feeTransferIndexes - wire-order indexes of inbound System
 *   transfers INTO the fee wallet, regardless of amount (owner
 *   ruling 2026-11-24: count transfer INSTRUCTIONS, not lamports)
 * @param valueMovingIndexes - wire-order indexes of the unified
 *   value-moving shapes (system transfer to any destination, funded
 *   account creation, nonce withdraw/initialize, token close, token
 *   burn or BurnChecked, Metaplex BurnNft)
 * @returns true when exactly one fee transfer exists and no
 *   value-moving instruction rides after it
 */
export function structuralConforms(feeTransferIndexes, valueMovingIndexes) {
  if (feeTransferIndexes.length !== 1) return false;
  const feeIdx = feeTransferIndexes[0];
  return !valueMovingIndexes.some((i) => i > feeIdx);
}

/**
 * Convenience wrapper: takes per-instruction facts in wire order.
 * @param ixFacts - array of { isInboundFeeTransfer, isValueMoving }
 */
export function feeRowStructureConforms(ixFacts) {
  const feeIdxs = [];
  const moving = [];
  ixFacts.forEach((f, i) => {
    if (f.isInboundFeeTransfer) feeIdxs.push(i);
    if (f.isValueMoving) moving.push(i);
  });
  return structuralConforms(feeIdxs, moving);
}
