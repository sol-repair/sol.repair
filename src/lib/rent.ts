/**
 * Rent figures for the guide pages.
 *
 * These numbers are not marketing copy. They are the mainnet
 * rent-exempt minimums for a standard 165-byte token account, read
 * straight from the chain (getMinimumBalanceForRentExemption). The
 * network lowered the rent rate on 2026-09-04 (SIMD-0437 step 1,
 * mainnet epoch 1028), so the minimum has a legacy value for accounts
 * created before that date and a current value for newer ones. Both
 * are pinned by tests and move together with the guide copy.
 *
 * No React in this file. Pure math, importable from tests.
 */

/** Rent-exempt minimum for a 165-byte token account created before
 *  mainnet epoch 1028 (2026-09-04). Re-verified 2026-09-03. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS_LEGACY = 2_039_280;

/** Rent-exempt minimum after SIMD-0437 step 1 went live at mainnet
 *  epoch 1028 (2026-09-04). Read directly from the chain that day. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS_CURRENT = 1_855_569;

/** A count the calculator will actually stand behind. Fewer than one
 *  account is not a wallet, and six figures of empty accounts has
 *  never been observed; anything outside this range is treated as
 *  input noise, not an estimate. */
const MIN_ACCOUNTS = 1;
const MAX_ACCOUNTS = 99_999;

/** Estimated rent locked in a number of empty token accounts as a
 *  [newer, older] lamports range, or null when the count is not a real
 *  account count. Accounts created before 2026-09-04 hold the legacy
 *  amount, so a range, not one number, is the honest estimate. */
export function estimateRentRange(
  accountCount: number
): [bigint, bigint] | null {
  if (!Number.isInteger(accountCount)) return null;
  if (accountCount < MIN_ACCOUNTS || accountCount > MAX_ACCOUNTS) return null;
  const count = BigInt(accountCount);
  return [
    count * BigInt(TOKEN_ACCOUNT_RENT_LAMPORTS_CURRENT),
    count * BigInt(TOKEN_ACCOUNT_RENT_LAMPORTS_LEGACY),
  ];
}

/** Lamports to a SOL string with no trailing-zero decoration. This
 *  matches how the fee ledger formats amounts: plain digits, nothing
 *  hidden by rounding. */
export function formatRentSol(lamports: bigint): string {
  const sol = Number(lamports) / 1_000_000_000;
  return sol.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
