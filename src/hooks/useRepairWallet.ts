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
 * Only one repair runs at a time: a synchronous in-flight flag makes a
 * second repair() call a no-op until the first finishes (including when it
 * fails - the flag is released in a finally). The wallet identity is also
 * pinned when the run starts; if the connected wallet changes mid-run the
 * repair stops before the next batch and reports it, instead of silently
 * building the remaining transactions for a different wallet.
 *
 * Flow per batch:
 *   1. buildTransaction() assembles the unsigned transaction (lib layer,
 *      fresh blockhash every attempt)
 *   2. The wallet adapter signs it (user approves in Phantom)
 *   3. The signed transaction is sent to the network
 *   4. We wait for confirmation
 *   5. If the blockhash expired (the user sat on the approval popup while
 *      the network moved on, or the wallet refused to sign because its
 *      own pre-prompt simulation outlived the window), we rebuild with a
 *      FRESH blockhash and ask for one more signature. The signed
 *      transaction cannot be reused - a new blockhash changes the bytes -
 *      so Phantom prompts again.
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

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import type { Connection } from "@solana/web3.js";

import {
  buildCloseAccountInstructions,
  verifyAccountsClosed,
} from "@/lib/solana/closeAccounts";
import { acquireAction, releaseAction } from "@/lib/actionMutex";
import { buildFeeTransfer } from "@/lib/solana/fees";
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
  | "checking"
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
  /** Raw library error text when the failure was none of the known
   *  kinds; rendered collapsed behind a toggle, never as the main
   *  line. Null whenever the error copy already explains the cause. */
  errorDetail: string | null;
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
  errorDetail: null,
};

/**
 * Repair ceiling: one run covers at most this many accounts - five
 * sequential wallet approvals of 20 closes each. The page previews the
 * same slice and tells the user the rest are closed by running the repair
 * again. Enforced here too (defense in depth), so no caller can grow a
 * run past five approval popups.
 */
export const MAX_ACCOUNTS_PER_RUN = 100;

// One retry per batch: a blockhash lives 150 slots, which is roughly
// 30-90 seconds depending on the cluster's slot pace (devnet has run
// hot at ~5 slots per second; mainnet runs ~400ms slots). If the
// approval popup - or the wallet's own pre-prompt simulation - outlives
// that window, the transaction is dead on arrival and the only fix is a
// fresh blockhash and a new signature.
const MAX_ATTEMPTS = 2;

/** A spent blockhash surfaces with several wordings: "Blockhash not
 *  found" when the RPC rejects the submission outright, "Signature
 *  ... has expired: block height exceeded." when the transaction dies
 *  while awaiting confirmation, and Phantom's "Transaction expired" /
 *  "TransactionExpiredBlockheightExceededError" when its pre-prompt
 *  simulation outlived the window and it refuses to sign at all. All
 *  of them must trigger the fresh-blockhash retry; matching only some
 *  of these shapes historically dead-stopped the repair on the rest. */
function isBlockhashExpiry(message: string): boolean {
  return /blockhash|block height|blockheight|expired/i.test(message);
}

/** Interval between getSignatureStatuses polls during confirmation. */
const CONFIRM_POLL_INTERVAL_MS = 1500;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Confirm a sent transaction by polling getSignatureStatuses over HTTP,
 * bounded by the blockhash the transaction was built with. This replaces
 * web3.js's websocket-based confirmTransaction, which cannot run on
 * failover provider endpoints that lack subscription support.
 *
 * Throws:
 *   - FriendlyError when the poll observes the transaction landed WITH an
 *     on-chain error. A landed-and-failed transaction reverted atomically:
 *     nothing closed, nothing moved. The shared catch verifies on-chain
 *     and reports honestly.
 *   - a blockhash-expiry error, worded so isBlockhashExpiry matches, when
 *     the blockhash died before any status appeared: the retry machinery
 *     treats it exactly as the previous confirmation path did.
 */
async function confirmByPolling(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number
): Promise<void> {
  for (;;) {
    const statuses = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: false,
    });
    const status = statuses.value[0];
    if (status?.err) {
      throw new FriendlyError(
        "The transaction was confirmed on-chain but failed. Nothing was closed and nothing was lost - run the repair again."
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }
    const blockHeight = await connection.getBlockHeight({
      commitment: "confirmed",
    });
    if (blockHeight > lastValidBlockHeight) {
      throw new Error("Blockhash block height exceeded");
    }
    await sleep(CONFIRM_POLL_INTERVAL_MS);
  }
}

/** An error whose message is ALREADY user-facing copy, thrown by this
 *  hook. Everything else that reaches the outer catch is raw library
 *  or network text (developer instructions included): the page must
 *  never print it as the main line, so it moves to errorDetail and is
 *  rendered collapsed behind a toggle. */
class FriendlyError extends Error {}

export function useRepairWallet() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [state, setState] = useState<RepairState>(INITIAL_STATE);

  // Synchronous in-flight flag (a ref, not state): set before the first
  // await so a second repair() call in the same tick is already a no-op,
  // and released in a finally so a failed or cancelled run never bricks
  // future repairs.
  const repairInFlight = useRef(false);

  // The wallet provider issues a NEW context object on every state
  // change, so an in-flight repair's captured `wallet` never sees a
  // later switch (B1). Mirror the live public key in a ref - stable
  // across re-renders, readable from inside the running repair - so the
  // mid-run check compares against the CURRENT wallet, not the snapshot
  // the run started with. Signing safety never depended on this (the
  // signer is pinned at start); the honest "wallet changed" report did.
  const livePublicKeyRef = useRef(wallet.publicKey);
  useEffect(() => {
    livePublicKeyRef.current = wallet.publicKey;
  }, [wallet.publicKey]);

  const repair = useCallback(
    async (accounts: ClosableAccount[], feeReady: boolean) => {
      if (repairInFlight.current) return;
      repairInFlight.current = true;
      // G.2 §8.12: cross-action mutex. The local ref above already
      // makes repair-vs-repair a silent no-op; this acquire is only
      // reachable when a DELEGATE REVOCATION holds the lock — a
      // situation that could not exist before G.2 — so every
      // pre-existing behavior is unchanged.
      if (!acquireAction("repair")) {
        repairInFlight.current = false;
        setState({
          ...INITIAL_STATE,
          status: "error",
          error: "Another wallet action is underway. Wait for it to finish.",
        });
        return;
      }
      try {
        if (!wallet.publicKey || !wallet.signTransaction) {
          setState({
            ...INITIAL_STATE,
            status: "error",
            error: "Wallet not connected or does not support signing.",
          });
          return;
        }

        // Pin the wallet identity for the whole run. Instructions, fee
        // payer, and signing all use these captured values, so the repair
        // can never drift onto a wallet the user connected mid-run. The
        // live wallet is compared before each batch below.
        const repairOwner = wallet.publicKey;
        const signer = wallet.signTransaction;
        let walletChanged = false;

        // The ceiling is enforced here too, whatever the caller passes:
        // this run covers at most MAX_ACCOUNTS_PER_RUN accounts (five
        // approvals). The page slices the same way and tells the user to
        // run the repair again for the rest.
        const runAccounts = accounts.slice(0, MAX_ACCOUNTS_PER_RUN);

        // Rent per account pubkey, for computing recovered amounts from the
        // set of accounts the chain says are actually closed.
        const lamportsOf = new Map(
          runAccounts.map((a) => [a.pubkey, a.lamports])
        );
        const recoveredOf = (pubkeys: Iterable<string>): bigint => {
          let sum = 0n;
          for (const p of pubkeys) sum += BigInt(lamportsOf.get(p) ?? 0);
          return sum;
        };

        const confirmed: string[] = [];
        const closedSoFar = new Set<string>();
        const batches = chunkInstructions(runAccounts);

        // feeReady is decided once by the page (does the fee account exist
        // on-chain?) and passed in, so the preview, the confirmation copy,
        // and this transaction can never disagree about the fee.

        const setRunState = (patch: Partial<RepairState>) =>
          setState((prev) => ({ ...prev, ...patch }));

        try {
          setRunState({
            ...INITIAL_STATE,
            status: "building",
            totalToClose: runAccounts.length,
            progress: { current: 1, total: batches.length },
          });

          for (let b = 0; b < batches.length; b++) {
            const batch = batches[b];
            // If the connected wallet changed since the run started, stop
            // BEFORE building the next transaction. Never sign for a
            // different identity than the one the user started with.
            // Reads the ref (the live key), not the captured snapshot.
            const livePublicKey = livePublicKeyRef.current;
            if (!livePublicKey || !livePublicKey.equals(repairOwner)) {
              walletChanged = true;
              throw new FriendlyError(
                "The connected wallet changed during the repair. Stopped before signing anything else. Reconnect the original wallet and run the repair again for the remaining accounts."
              );
            }
            let instructions = buildCloseAccountInstructions(
              batch,
              repairOwner
            );
            // The 1% fee rides in the same transaction, AFTER the closes, so
            // the rent they just returned covers it. It shows up in the wallet
            // as a plain transfer before the user approves.
            const fee = feeReady
              ? buildFeeTransfer(repairOwner, batch)
              : null;
            if (fee) instructions.push(fee);
            const progress = { current: b + 1, total: batches.length };
            let batchLanded = false;
            // The signature that identifies the transaction this batch
            // actually landed with, when one exists. Null when the batch
            // was closed by something else entirely (a wallet-refusal
            // attempt never signed, then the chain check found the
            // accounts already closed).
            let landedSignature: string | null = null;

            for (let attempt = 1; attempt <= MAX_ATTEMPTS && !batchLanded; attempt++) {
              try {
                // 1. Assemble the unsigned transaction (fresh blockhash
                //    each attempt - this is the whole point of the retry).
                setRunState({ status: "building", progress });
                const transaction = await buildTransaction(
                  connection,
                  repairOwner,
                  instructions
                );

                // 2. Hand the unsigned transaction to the wallet for
                //    signing. This is where Phantom pops up and the user
                //    clicks Approve. Nothing is signed until the user
                //    explicitly approves.
                setRunState({ status: "awaiting-signature", progress });
                const signed = await signer(transaction);

                // The signature is derived from the signed payload itself,
                // so it identifies this exact transaction no matter who
                // submits it - our app or the wallet's own submission.
                const signatureBytes = signed.signatures[0]?.signature;
                if (!signatureBytes) {
                  throw new FriendlyError(
                    "Wallet returned a transaction without a signature. Nothing was sent."
                  );
                }
                const signature = bs58.encode(signatureBytes);
                landedSignature = signature;
                setRunState({
                  status: "sending",
                  signature: confirmed[0] ?? signature,
                  signatures: [...confirmed],
                });

                // 3. Send the signed transaction to the network.
                const sentSignature = await connection.sendRawTransaction(
                  signed.serialize()
                );

                // 4. Wait for confirmation by polling getSignatureStatuses
                //    over HTTP. The websocket-based confirmTransaction is
                //    endpoint-bound: failover provider endpoints (e.g.
                //    Alchemy devnet) do not support signatureSubscribe, so
                //    a repair would hang there. Polling is bounded by the
                //    same lastValidBlockHeight the transaction was built
                //    with, so it can never wait indefinitely.
                await confirmByPolling(
                  connection,
                  sentSignature,
                  transaction.lastValidBlockHeight!
                );

                batchLanded = true;
              } catch (attemptError) {
                // A failed attempt covers more than a failed send. The
                // wallet may have submitted the transaction itself before
                // our send ran (some wallets do, when their own
                // simulation failed), or it may have refused to sign at
                // all because its pre-prompt simulation outlived the
                // blockhash window - the adapter rejects with an
                // expiry-shaped error and no prompt ever showed. Every
                // shape gets the same honest treatment: ask the chain
                // what actually happened, and retry with a fresh
                // blockhash when the failure was expiry-shaped.
                // Not "verifying": verifying is only for transactions this
                // app knows were sent. Here the submission may have failed
                // or never happened, and the wallet may have submitted
                // independently, so nothing about "sent" is proven yet.
                // The UI must not say so.
                setRunState({ status: "checking", progress });

                const { closedPubkeys, stillOpenPubkeys } =
                  await verifyAccountsClosed(connection, batch);

                if (closedPubkeys.length === batch.length) {
                  // Everything in this batch is closed. The repair
                  // succeeded; our submission simply lost the race (or the
                  // wallet refused this attempt while something else
                  // closed the accounts). Fall through to the bookkeeping
                  // below (a break here would skip it).
                  batchLanded = true;
                } else {
                  // Not landed. An expired blockhash is retryable with a
                  // fresh one; anything else fails this batch.
                  const message =
                    attemptError instanceof Error
                      ? attemptError.message
                      : String(attemptError);
                  if (
                    attempt < MAX_ATTEMPTS &&
                    isBlockhashExpiry(message)
                  ) {
                    // A transaction is atomic, so this batch cannot have
                    // partially landed on its own - accounts the chain
                    // still reports open just didn't close. Rebuild the
                    // batch from only those: re-signing the already-closed
                    // ones would doom the retry (closing a nonexistent
                    // account fails the whole transaction).
                    const stillOpenBatch = batch.filter((account) =>
                      stillOpenPubkeys.includes(account.pubkey)
                    );
                    instructions = buildCloseAccountInstructions(
                      stillOpenBatch,
                      repairOwner
                    );
                    // The 1% fee rides on what the retry actually closes.
                    const retryFee = feeReady
                      ? buildFeeTransfer(repairOwner, stillOpenBatch)
                      : null;
                    if (retryFee) instructions.push(retryFee);
                    // Nothing landed with the refused attempt's bytes; a
                    // retry that lands carries its own signature.
                    landedSignature = null;
                    continue;
                  }
                  throw attemptError;
                }
              }

              if (batchLanded) {
                if (landedSignature) confirmed.push(landedSignature);
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
            totalToClose: runAccounts.length,
            recoveredLamports: recoveredOf(closedSoFar),
            progress: null,
            error: null,
            errorDetail: null,
          });
        } catch (err) {
          // The run stopped - real error, expired blockhash (twice), a
          // wallet switch, or the user cancelled an approval. Batches that
          // already landed are still repaired; report that honestly instead
          // of all-or-nothing.
          const message = err instanceof Error ? err.message : String(err);
          const rejected =
            message.toLowerCase().includes("user rejected") ||
            message.toLowerCase().includes("rejected");
          // A blockhash expiry is a dead transaction, never a lost one.
          const expired = isBlockhashExpiry(message);

          let closedPubkeys: string[] = [];
          let verifyFailed = false;
          try {
            // "checking", not "verifying": the run stopped for reasons that
            // include cancellation and failures where nothing was sent.
            // The UI must not claim "sent" while the chain is being asked
            // what actually landed.
            setRunState({ status: "checking" });
            const verified = await verifyAccountsClosed(connection, runAccounts);
            closedPubkeys = verified.closedPubkeys;
          } catch {
            // Verification itself failed. Fall back to the run's own
            // confirmed bookkeeping below instead of reporting zero
            // progress while transactions are provably on-chain.
            verifyFailed = true;
          }

          // When the chain could not be asked, the run's receipts are the
          // honest source: closedSoFar only ever grew from batches whose
          // confirmation resolved (or whose on-chain verification said
          // closed), each with a kept signature.
          const reportClosed = verifyFailed ? [...closedSoFar] : closedPubkeys;
          const closed = reportClosed.length;
          const partial = closed > 0;

          // Raw library text only surfaces when the copy does not already
          // explain the cause (rejected, expired, or thrown by this hook).
          const rawDetail =
            rejected || expired || err instanceof FriendlyError
              ? null
              : message;

          setState({
            status: "error",
            signature: confirmed[0] ?? null,
            signatures: [...confirmed],
            closedCount: closed,
            totalToClose: runAccounts.length,
            recoveredLamports: recoveredOf(reportClosed),
            progress: null,
            error: partial
              ? `Repair stopped after ${closed} of ${runAccounts.length} accounts were closed (${lamportsToSol(recoveredOf(reportClosed))} SOL recovered). Run the repair again to finish the rest - already-closed accounts are simply skipped.${rejected ? " You cancelled the remaining approvals." : ""}${walletChanged ? " The connected wallet changed during the run." : ""}${verifyFailed ? " On-chain verification could not be reached, so this count is from the confirmed transactions - the linked signature is the receipt." : ""}`
              : rejected
                ? "Transaction cancelled. Nothing was sent."
                : expired
                  ? "The transaction expired while waiting for approval. The network moved on while the wallet window was open. Nothing was sent and nothing was lost. Please try again and approve promptly."
                  : err instanceof FriendlyError
                    ? message
                    : "The repair transaction did not go through. No accounts were closed when we checked the chain. Solana transactions are atomic, so nothing half-landed. Dismiss to refresh the scan, then run the repair again if accounts are still open.",
            errorDetail: rawDetail,
          });
        }
      } finally {
        releaseAction("repair");
        repairInFlight.current = false;
      }
    },
    [connection, wallet]
  );

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return { ...state, repair, reset };
}
