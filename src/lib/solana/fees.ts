import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import { IS_MAINNET } from "./connection";
import type { ClosableAccount } from "./tokenAccounts";

/**
 * The 1% success fee, charged on recovered rent.
 *
 * The fee is a plain SystemProgram transfer from the user's wallet to the
 * fee address below. It is appended AFTER the closeAccount instructions in
 * each transaction, so the rent those closes just returned covers it, even
 * for a wallet starting from zero. Users see the transfer in their wallet
 * before they approve, same as everything else.
 */

export const FEE_PERCENT = 1;

/**
 * Devnet fee goes to the seeding payer's devnet wallet, a separate account
 * from the test wallet, so test runs can watch the fee land exactly the way
 * it will on mainnet.
 */
export const DEV_FEE_WALLET = new PublicKey(
  "4Z5iVtvydRcrMJdRbrXSpn3vhrxzLE8hZGnzm6ejMKpn"
);

/**
 * Mainnet fee wallet (Ledger). Fees stay off on mainnet until this address
 * has seen its first deposit: a transfer to an address that has never
 * existed on-chain fails the transaction, so feeAccountReady checks for it
 * at repair time and the fee is skipped until it exists.
 */
export const MAINNET_FEE_WALLET = new PublicKey(
  "6qhajWTtUKadkMaumpADGBkmPkASiwXRqGtqd8ypL74K"
);

export function getFeeRecipient(): PublicKey {
  return IS_MAINNET ? MAINNET_FEE_WALLET : DEV_FEE_WALLET;
}

/**
 * Mainnet safety net. If the mainnet fee address ever equals the devnet fee
 * wallet (someone reverted the swap), fees turn off instead of routing real
 * SOL anywhere wrong. Fails toward the user, never toward a wrong address.
 */
export function isFeeEnabled(): boolean {
  return !IS_MAINNET || !getFeeRecipient().equals(DEV_FEE_WALLET);
}

/**
 * A transfer can only target an account that already exists on-chain, so a
 * brand new fee address needs one small first deposit before fees can land.
 * Returns false until then, and callers skip the fee. The repair itself
 * never depends on the fee, so a missing fee account must not break it.
 */
export async function feeAccountReady(
  connection: Connection
): Promise<boolean> {
  try {
    const info = await connection.getAccountInfo(getFeeRecipient());
    return info !== null;
  } catch {
    return false;
  }
}

/** 1% of a batch's total rent, floored to whole lamports. */
export function feeAmountLamports(batch: ClosableAccount[]): bigint {
  const total = batch.reduce((sum, a) => sum + BigInt(a.lamports), 0n);
  return (total * BigInt(FEE_PERCENT)) / 100n;
}

/**
 * The fee transfer instruction for one batch, or null when there is no fee
 * to charge (fees disabled, or the batch is empty).
 */
export function buildFeeTransfer(
  owner: PublicKey,
  batch: ClosableAccount[]
): TransactionInstruction | null {
  if (!isFeeEnabled() || batch.length === 0) {
    return null;
  }
  const lamports = feeAmountLamports(batch);
  if (lamports <= 0n) {
    return null;
  }
  return SystemProgram.transfer({
    fromPubkey: owner,
    toPubkey: getFeeRecipient(),
    lamports,
  });
}
