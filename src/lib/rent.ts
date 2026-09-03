/**
 * Rent figures for the guide pages.
 *
 * The number below is not marketing copy. It is the mainnet
 * rent-exempt minimum for a standard 165-byte token account, read
 * straight from the chain (getMinimumBalanceForRentExemption) and
 * re-verified 2026-09-03. The network has a rent reduction in
 * progress, so when the parked rent-copy trigger fires, this constant
 * and every guide page that mentions it move in the same commit.
 *
 * No React in this file. Pure math, importable from tests.
 */

/** Mainnet rent-exempt minimum for one 165-byte token account. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;

/** A count the calculator will actually stand behind. Fewer than one
 *  account is not a wallet, and six figures of empty accounts has
 *  never been observed; anything outside this range is treated as
 *  input noise, not an estimate. */
const MIN_ACCOUNTS = 1;
const MAX_ACCOUNTS = 99_999;

/** Estimated rent locked in a number of empty token accounts, in
 *  lamports, or null when the count is not a real account count. */
export function estimateRentLamports(accountCount: number): bigint | null {
  if (!Number.isInteger(accountCount)) return null;
  if (accountCount < MIN_ACCOUNTS || accountCount > MAX_ACCOUNTS) return null;
  return BigInt(accountCount) * BigInt(TOKEN_ACCOUNT_RENT_LAMPORTS);
}

/** Lamports to a SOL string with no trailing-zero decoration. This
 *  matches how the fee ledger formats amounts: plain digits, nothing
 *  hidden by rounding. */
export function formatRentSol(lamports: bigint): string {
  const sol = Number(lamports) / 1_000_000_000;
  return sol.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
