"use client";

/**
 * useRepairWallet: React hook that builds and submits CloseAccount
 * transactions for the user's eligible token accounts.
 *
 * Large repairs are BATCHED: a Solana transaction fits roughly 20 close
 * instructions (1232-byte packet limit), so wallets with more eligible
 * accounts get multiple sequential transactions, each approved in the
 * wallet. The hook reports per-transaction progress, and if the repair
 * stops midway (failure or the user cancelling later approvals) it reports
 * exactly how much was already repaired, verified on-chain - never an
 * all-or-nothing error when money already moved.
 *
 * Flow per batch:
 *   1. buildTransaction() assembles the unsigned transaction (lib layer,
 *      fresh blockhash every attempt)
 *   2. The wallet adapter signs it (user approves in Phantom)
 *   3. The signed transaction is sent to the network
 *   4. We wait for confirmation
 *   5. If the blockhash expired (the user sat on the approval popup while
 *      the network moved on), we rebuild with a FRESH blockhash and ask for
 *      one more signature. The signed transaction cannot be reused - a new
 *      blockhash changes the bytes - so Phantom prompts again.
 *
 * Submission race handling: some wallets (notably Phantom when confirming a
 * transaction that failed the wallet's internal simulation) submit the signed
 * transaction themselves. Our own submission can then fail with
 * "InvalidAccountData" because the accounts are ALREADY closed - a success,
 * not a failure. So before reporting any send/confirm error, we verify the
 * actual on-chain state via verifyAccountsClosed(). The chain is the only
 * source of truth.
 *
 * This hook NEVER signs anything itself. It hands the unsigned transaction to
 * the wallet adapter, which hands it to Phantom for the user to approve.
 */

import { useCallback, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";

import {
  buildCloseAccountInstructions,
  verifyAccountsClosed,
} from "@/lib/solana/closeAccounts";
import { buildFeeTransfer, feeAccountReady } from "@/lib/solana/fees";
import {
  buildTransaction,
  chunkInstructions,
} from "@/lib/solana/transactions";
import {
  lamportsToSol,
  type ClosableAccount,
} from "@/lib/solana/tokenAccounts";

type RepairStatus =
  | "idle"
  | "building"
  | "awaiting-signature"
  | "sending"
  | "verifying"
  | "done"
  | "error";

/** Which transaction of a multi-transaction repair the user is on. */
interface RepairProgress {
  /** 1-based index of the current transaction. */
  current: number;
  /** Total transactions in this repair. */
  total: number;
}

interface RepairState {
  status: RepairStatus;
  /** First confirmed signature; used as the primary explorer link. */
  signature: string | null;
  /** All confirmed signatures, one per landed transaction. */
  signatures: string[];
  /** How many of this run's accounts are verified closed on-chain. */
  closedCount: number;
  /** Accounts included in the current repair run (0 when idle). */
  totalToClose: number;
  /** Rent sum across the verified-closed accounts. */
  recoveredLamports: bigint;
  /** Multi-transaction progress while awaiting approvals. */
  progress: RepairProgress | null;
  error: string | null;
}

const INITIAL_STATE: RepairState = {
  status: "idle",
  signature: null,
  signatures: [],
  closedCount: 0,
  totalToClose: 0,
  recoveredLamports: 0n,
  progress: null,
  error: null,
};

// One retry per batch: a blockhash lives ~60-90s. If the user sits on the
// wallet approval popup that long (easy on a slow network), the transaction
// is dead on arrival and the only fix is a fresh blockhash and a new
// signature.
const MAX_ATTEMPTS = 2;

export function useRepairWallet() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [state, setState] = useState<RepairState>(INITIAL_STATE);

  const repair = useCallback(
    async (accounts: ClosableAccount[]) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setState({
          ...INITIAL_STATE,
          status: "error",
          error: "Wallet not connected or does not support signing.",
        });
        return;
      }

      // Rent per account pubkey, for computing recovered amounts from the
      // set of accounts the chain says are actually closed.
      const lamportsOf = new Map(accounts.map((a) => [a.pubkey, a.lamports]));
      const recoveredOf = (pubkeys: Iterable<string>): bigint => {
        let sum = 0n;
        for (const p of pubkeys) sum += BigInt(lamportsOf.get(p) ?? 0);
        return sum;
      };

      const confirmed: string[] = [];
      const closedSoFar = new Set<string>();
      const batches = chunkInstructions(accounts);

      // Fees need the fee account to exist on-chain (it does not until its
      // first deposit). Check once and skip the fee if it is not there yet.
      // The repair itself never depends on the fee.
      let feeReady = false;
      try {
        feeReady = await feeAccountReady(connection);
      } catch {
        feeReady = false;
      }

      const setRunState = (patch: Partial<RepairState>) =>
        setState((prev) => ({ ...prev, ...patch }));

      try {
        setRunState({
          ...INITIAL_STATE,
          status: "building",
          totalToClose: accounts.length,
          progress: { current: 1, total: batches.length },
        });

        for (let b = 0; b < batches.length; b++) {
          const batch = batches[b];
          const instructions = buildCloseAccountInstructions(
            batch,
            wallet.publicKey
          );
          // The 1% fee rides in the same transaction, AFTER the closes, so
          // the rent they just returned covers it. It shows up in the wallet
          // as a plain transfer before the user approves.
          const fee = feeReady
            ? buildFeeTransfer(wallet.publicKey, batch)
            : null;
          if (fee) instructions.push(fee);
          const progress = { current: b + 1, total: batches.length };
          let batchLanded = false;

          for (let attempt = 1; attempt <= MAX_ATTEMPTS && !batchLanded; attempt++) {
            // 1. Assemble the unsigned transaction (fresh blockhash each
            //    attempt - this is the whole point of the retry).
            setRunState({ status: "building", progress });
            const transaction = await buildTransaction(
              connection,
              wallet.publicKey,
              instructions
            );

            // 2. Hand the unsigned transaction to the wallet for signing.
            //    This is where Phantom pops up and the user clicks Approve.
            //    Nothing is signed until the user explicitly approves.
            setRunState({ status: "awaiting-signature", progress });
            const signed = await wallet.signTransaction(transaction);

            // The signature is derived from the signed payload itself, so it
            // identifies this exact transaction no matter who submits it -
            // our app or the wallet's own submission.
            const signatureBytes = signed.signatures[0]?.signature;
            if (!signatureBytes) {
              throw new Error(
                "Wallet returned a transaction without a signature. Nothing was sent."
              );
            }
            const signature = bs58.encode(signatureBytes);
            setRunState({
              status: "sending",
              signature: confirmed[0] ?? signature,
              signatures: [...confirmed],
            });

            try {
              // 3. Send the signed transaction to the network.
              const sentSignature = await connection.sendRawTransaction(
                signed.serialize()
              );

              // 4. Wait for confirmation. Passing the blockhash +
              //    lastValidBlockHeight (rather than just the signature)
              //    bounds the wait: confirmation ends once the blockhash
              //    expires, instead of polling indefinitely.
              await connection.confirmTransaction(
                {
                  signature: sentSignature,
                  blockhash: transaction.recentBlockhash!,
                  lastValidBlockHeight: transaction.lastValidBlockHeight!,
                },
                "confirmed"
              );

              batchLanded = true;
            } catch (sendError) {
              // Our submission failed - but that may not mean the repair
              // failed. The wallet may have submitted the transaction itself
              // and it may have already landed. Ask the chain what actually
              // happened.
              setRunState({ status: "verifying", progress });

              const { closedPubkeys } = await verifyAccountsClosed(
                connection,
                batch
              );

              if (closedPubkeys.length === batch.length) {
                // Everything in this batch is closed. The repair succeeded;
                // our submission simply lost the race. Fall through to the
                // bookkeeping below (a break here would skip it).
                batchLanded = true;
              } else {
                // Not landed. An expired blockhash is retryable with a fresh
                // one; anything else fails this batch.
                const message =
                  sendError instanceof Error
                    ? sendError.message
                    : String(sendError);
                if (attempt < MAX_ATTEMPTS && /blockhash/i.test(message)) {
                  continue;
                }
                throw sendError;
              }
            }

            if (batchLanded) {
              confirmed.push(signature);
              for (const a of batch) closedSoFar.add(a.pubkey);
              setRunState({
                signatures: [...confirmed],
                signature: confirmed[0],
                closedCount: closedSoFar.size,
                recoveredLamports: recoveredOf(closedSoFar),
              });
            }
          }
        }

        // All batches landed.
        setState({
          status: "done",
          signature: confirmed[0],
          signatures: [...confirmed],
          closedCount: closedSoFar.size,
          totalToClose: accounts.length,
          recoveredLamports: recoveredOf(closedSoFar),
          progress: null,
          error: null,
        });
      } catch (err) {
        // The run stopped - real error, expired blockhash (twice), or the
        // user cancelled an approval. Batches that already landed are still
        // repaired; report that honestly instead of all-or-nothing.
        const message = err instanceof Error ? err.message : String(err);
        const rejected =
          message.toLowerCase().includes("user rejected") ||
          message.toLowerCase().includes("rejected");
        // A blockhash expiry is a dead transaction, never a lost one.
        const expired = /blockhash/i.test(message);

        let closedPubkeys: string[] = [];
        try {
          setRunState({ status: "verifying" });
          const verified = await verifyAccountsClosed(connection, accounts);
          closedPubkeys = verified.closedPubkeys;
        } catch {
          // Verification itself failed; report without partial info rather
          // than masking the original error.
        }

        const closed = closedPubkeys.length;
        const partial = closed > 0;

        setState({
          status: "error",
          signature: confirmed[0] ?? null,
          signatures: [...confirmed],
          closedCount: closed,
          totalToClose: accounts.length,
          recoveredLamports: recoveredOf(closedPubkeys),
          progress: null,
          error: partial
            ? `Repair stopped after ${closed} of ${accounts.length} accounts were closed (${lamportsToSol(recoveredOf(closedPubkeys))} SOL recovered). Run the repair again to finish the rest - already-closed accounts are simply skipped.${rejected ? " You cancelled the remaining approvals." : ""}`
            : rejected
              ? "Transaction cancelled. Nothing was sent."
              : expired
                ? "The transaction expired while waiting for approval. Nothing was sent and nothing was lost. Please try again and approve promptly."
                : message,
        });
      }
    },
    [connection, wallet]
  );

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return { ...state, repair, reset };
}
