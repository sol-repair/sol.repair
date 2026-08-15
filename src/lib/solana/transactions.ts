/**
 * Transaction assembly helpers. Takes CloseAccount instructions and
 * assembles them into a Transaction ready for the user's wallet to sign.
 *
 * Signing always happens in the wallet adapter at the React layer. This
 * module never signs anything, it only builds the unsigned transaction.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Assemble a batch of CloseAccount instructions into a single Transaction.
 *
 * Solana transactions are limited to 1232 bytes. Each CloseAccount
 * instruction costs ~39 bytes compiled (7 instruction overhead + 32 for the
 * token account key), so roughly 28 fit per transaction; we cap at 20 to
 * leave headroom for wallets that append their own instructions (Phantom
 * adds Compute Budget instructions, for example). Wallets with more
 * eligible accounts are handled by splitting into multiple transactions -
 * see chunkInstructions and the batch loop in useRepairWallet.
 *
 * @param connection    The Solana RPC connection (for recent blockhash).
 * @param payer         The wallet paying the transaction fee and signing.
 * @param instructions  The CloseAccount instructions to include (<= 20).
 * @returns             An unsigned Transaction ready for signing.
 */
export async function buildTransaction(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[]
): Promise<Transaction> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  const transaction = new Transaction({
    feePayer: payer,
    blockhash,
    lastValidBlockHeight,
  }).add(...instructions);

  return transaction;
}

/**
 * Maximum CloseAccount instructions packed into one transaction. 20 is
 * comfortably under the ~28 that fit in the 1232-byte packet limit, leaving
 * room for wallet-added instructions.
 */
export const MAX_CLOSE_INSTRUCTIONS_PER_TX = 20;

/**
 * Split a list into chunks of at most `maxPerChunk` items, preserving order.
 * Used to split large repairs into multiple signable transactions.
 */
export function chunkInstructions<T>(
  items: T[],
  maxPerChunk: number = MAX_CLOSE_INSTRUCTIONS_PER_TX
): T[][] {
  if (maxPerChunk < 1) {
    throw new Error("maxPerChunk must be >= 1");
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += maxPerChunk) {
    chunks.push(items.slice(i, i + maxPerChunk));
  }
  return chunks;
}

/**
 * Estimate the network fee for one transaction.
 *
 * Solana charges a base fee of 5000 lamports per signature. Each transaction
 * in a batched repair carries one signature (the wallet owner), and v1 does
 * not add priority fees of its own.
 *
 * @returns Estimated fee in lamports per transaction.
 */
export function estimateNetworkFee(): bigint {
  return 5000n;
}
