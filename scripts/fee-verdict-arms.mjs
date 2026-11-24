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
// definition across all three implementations (auditor rounds 3-4,
// 2026-11-24; the app ledger, the bell, and the weekly counter may
// differ in decoding but never in verdict or facts, pinned by
// tests/feeWireFacts.test.ts): a system transfer to any destination
// (tag 2 or 11), funded system account creation (CreateAccount,
// CreateAccountWithSeed, and CreateAccountAllowPrefund - SIMD-0312
// tag 13, value-moving unconditionally, its unfunded lamports-0
// variant included by choice on the stricter side), the nonce
// account's WithdrawNonceAccount (genuinely value-moving - it
// empties the nonce account to a destination), and
// InitializeNonceAccount - which transfers NO lamports (the account
// must already be rent-exempt; the instruction only initializes
// state) and is in the set as a DELIBERATELY PROHIBITED
// STATE-INITIALIZATION INSTRUCTION, an explicit owner ruling
// stricter than value-inertness requires; AdvanceNonce and
// AuthorizeNonceAccount are OUT (no lamports move). Plus a token
// close, a token burn or BurnChecked (tag 15), and a Metaplex
// BurnNft.
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
 *   account creation including AllowPrefund, nonce withdraw and the
 *   prohibited nonce initialize, token close, token burn or
 *   BurnChecked, Metaplex BurnNft)
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
