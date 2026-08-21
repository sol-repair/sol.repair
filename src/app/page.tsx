"use client";

import { useCallback, useMemo, useState } from "react";
import {
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { NetworkBadge } from "@/components/NetworkBadge";
import { WalletButton } from "@/components/WalletButton";
import { useWalletScan } from "@/hooks/useWalletScan";
import { useRepairWallet } from "@/hooks/useRepairWallet";
import { lamportsToSol } from "@/lib/solana/tokenAccounts";
import { SOLANA_NETWORK } from "@/lib/solana/connection";
import { buildCloseAccountInstructions } from "@/lib/solana/closeAccounts";
import {
  buildFeeTransfer,
  feeAccountReady,
  feeAmountLamports,
  getFeeRecipient,
} from "@/lib/solana/fees";
import {
  buildTransaction,
  chunkInstructions,
} from "@/lib/solana/transactions";
import Link from "next/link";

/** One entry in the raw transaction inspector. Close and fee entries share
 *  the program/instruction fields and differ in the rest. */
type PreviewInstruction = {
  program: string;
  instruction: string;
  accountToClose?: string;
  rentDestination?: string;
  closeAuthority?: string;
  from?: string;
  to?: string;
  lamports?: string;
  note?: string;
};

/**
 * Explorer link for a transaction signature, or the raw signature text when
 * the active network has no public explorer. Local validator transactions
 * exist only on the machine running the validator, so linking them to
 * Solscan would always 404.
 */
function explorerUrl(signature: string): string | null {
  if (SOLANA_NETWORK === "mainnet-beta") {
    return `https://solscan.io/tx/${signature}`;
  }
  if (SOLANA_NETWORK === "devnet") {
    // Without the cluster param Solscan searches mainnet and misses devnet txs.
    return `https://solscan.io/tx/${signature}?cluster=devnet`;
  }
  if (SOLANA_NETWORK === "testnet") {
    return `https://solscan.io/tx/${signature}?cluster=testnet`;
  }
  return null;
}

function ExplorerLink({ signature }: { signature: string }) {
  const href = explorerUrl(signature);
  if (href === null) {
    return (
      <p className="mt-3 break-all font-mono text-xs text-zinc-500">
        Signature: {signature}
      </p>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-3 inline-block text-sm text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
    >
      View on Solscan
    </a>
  );
}

/** Explorer link for an account or mint address (not a transaction). */
function accountUrl(address: string): string | null {
  if (SOLANA_NETWORK === "mainnet-beta") {
    return `https://solscan.io/account/${address}`;
  }
  if (SOLANA_NETWORK === "devnet") {
    return `https://solscan.io/account/${address}?cluster=devnet`;
  }
  if (SOLANA_NETWORK === "testnet") {
    return `https://solscan.io/account/${address}?cluster=testnet`;
  }
  return null;
}

/** Short form for on-chain addresses in dense lists; full address stays
 *  available in the title tooltip and via the Solscan link. */
function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function AccountLink({ address, label }: { address: string; label?: string }) {
  const href = accountUrl(address);
  if (href === null) {
    return <span title={address}>{short(address)}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      onClick={(e) => e.stopPropagation()}
      className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
    >
      {label ? `${label} ` : ""}
      {short(address)}
    </a>
  );
}

export default function Home() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const { loading, result, error: scanError, rescan } = useWalletScan();
  const {
    status,
    signature,
    signatures,
    closedCount,
    recoveredLamports,
    progress,
    error: repairError,
    repair,
    reset,
  } = useRepairWallet();

  // Whether the user has clicked "Repair" and is in the confirmation step.
  const [confirming, setConfirming] = useState(false);

  // Optional pre-sign simulation ("show your work"): run every batch
  // through the RPC simulator before the user signs anything.
  const [sim, setSim] = useState<
    | { state: "idle" }
    | { state: "running" }
    | { state: "ok"; netSol: string; txCount: number }
    | { state: "error"; error: string }
  >({ state: "idle" });

  const hasEligible = result && result.eligibleAccounts.length > 0;

  // --- Account selection: granular user control over WHAT gets closed. ---
  // Scammers drain everything at once; a legitimate tool lets you choose.
  // Defaults to all eligible selected; resets whenever a fresh scan lands.
  // Adjusted during render (React's "reset state on data change" pattern)
  // instead of in an effect, so a new scan result can't leak stale selection.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prevResult, setPrevResult] = useState(result);

  if (result !== prevResult) {
    setPrevResult(result);
    setSelected(new Set(result?.eligibleAccounts.map((a) => a.pubkey) ?? []));
  }

  const toggleSelected = useCallback((pubkey: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pubkey)) {
        next.delete(pubkey);
      } else {
        next.add(pubkey);
      }
      return next;
    });
  }, []);

  const selectedAccounts = useMemo(
    () =>
      result
        ? result.eligibleAccounts.filter((a) => selected.has(a.pubkey))
        : [],
    [result, selected]
  );
  const selectedCount = selectedAccounts.length;
  const selectedLamports = useMemo(
    () =>
      selectedAccounts.reduce((sum, a) => sum + BigInt(a.lamports), 0n),
    [selectedAccounts]
  );

  // The 1% service fee across all selected accounts (summed per batch, the
  // same way the repair charges it).
  const serviceFeeLamports = useMemo(
    () =>
      chunkInstructions(selectedAccounts).reduce(
        (sum, batch) => sum + feeAmountLamports(batch),
        0n
      ),
    [selectedAccounts]
  );

  // Repairs larger than one transaction's instruction budget are split into
  // sequential approvals; tell the user up front how many to expect.
  const batchCount = selectedCount
    ? chunkInstructions(selectedAccounts).length
    : 1;

  // Human-readable preview of the first transaction's instructions, built
  // with the SAME builders the repair uses. Display only, nothing is sent.
  const firstBatchPreview = useMemo(() => {
    if (!publicKey || selectedCount === 0) {
      return null;
    }
    const first = chunkInstructions(selectedAccounts)[0];
    const preview: PreviewInstruction[] = buildCloseAccountInstructions(
      first,
      publicKey
    ).map((_, i) => ({
      program:
        first[i].program === "token-2022"
          ? "Token-2022 Program"
          : "SPL Token Program",
      instruction: "closeAccount",
      accountToClose: first[i].pubkey,
      rentDestination: publicKey.toBase58(),
      closeAuthority: publicKey.toBase58(),
    }));
    const fee = buildFeeTransfer(publicKey, first);
    if (fee) {
      preview.push({
        program: "System Program",
        instruction: "transfer",
        from: publicKey.toBase58(),
        to: getFeeRecipient().toBase58(),
        lamports: feeAmountLamports(first).toString(),
        note: "1% success fee",
      });
    }
    return preview;
  }, [publicKey, selectedAccounts, selectedCount]);

  // Simulate every batch against the RPC (no signature needed). Passing the
  // simulation proves the transactions execute cleanly; the net SOL change
  // is computed deterministically from the scan (rent minus network and
  // service fees).
  const runSimulation = useCallback(async () => {
    if (!publicKey || selectedCount === 0) return;
    setSim({ state: "running" });
    try {
      const batches = chunkInstructions(selectedAccounts);
      // Same fee gating as the real repair: the fee account must exist.
      let feeReady = false;
      try {
        feeReady = await feeAccountReady(connection);
      } catch {
        feeReady = false;
      }
      for (const batch of batches) {
        const instructions = buildCloseAccountInstructions(batch, publicKey);
        // Same shape as the real repair: closes first, fee transfer last.
        const fee = feeReady ? buildFeeTransfer(publicKey, batch) : null;
        if (fee) instructions.push(fee);
        const transaction = await buildTransaction(
          connection,
          publicKey,
          instructions
        );
        // web3.js v1 only accepts simulation config on VersionedTransaction,
        // so wrap the compiled legacy message (same bytes the wallet signs).
        const versioned = new VersionedTransaction(
          transaction.compileMessage()
        );
        const res = await connection.simulateTransaction(versioned, {
          sigVerify: false,
          replaceRecentBlockhash: true,
        });
        if (res.value.err) {
          throw new Error(JSON.stringify(res.value.err));
        }
      }
      const feeLamports = 5000n * BigInt(batches.length);
      setSim({
        state: "ok",
        netSol: lamportsToSol(
          selectedLamports - feeLamports - (feeReady ? serviceFeeLamports : 0n)
        ),
        txCount: batches.length,
      });
    } catch (e) {
      setSim({
        state: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [connection, publicKey, selectedAccounts, selectedCount, selectedLamports, serviceFeeLamports]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center justify-between">
          <span className="font-mono text-sm text-zinc-500">SOL.repair</span>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/sol-repair/sol.repair"
              target="_blank"
              rel="noopener noreferrer"
              title="Source code on GitHub"
              aria-label="Source code on GitHub"
              className="text-zinc-500 transition-colors hover:text-zinc-200"
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-5 w-5"
                aria-hidden="true"
              >
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
            </a>
            <NetworkBadge />
          </div>
        </div>

        <h1 className="mb-3 text-3xl font-semibold tracking-tight text-zinc-50">
          Reclaim SOL from empty token accounts.
        </h1>
        <p className="mb-2 text-zinc-400">
          Close dusty SPL accounts and get your rent-exempt deposits back.
        </p>
        <p className="mb-8 text-zinc-400">
          100% open source.{" "}
          <a
            href="https://github.com/sol-repair/sol.repair"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-zinc-200"
          >
            Read the code
          </a>
          . 1% success fee.
        </p>
        <p className="mb-8 font-mono text-xs leading-relaxed text-zinc-500">
          This tool batches createCloseAccountInstruction to return your
          ~0.002 SOL rent.
          <br />
          You sign every transaction. Funds go straight to your wallet.
        </p>

        <div className="mb-8">
          <WalletButton />
          <p className="mt-3 text-center text-xs leading-relaxed text-zinc-500">
            Read-only connection. Powered by @solana/wallet-adapter.
          </p>
        </div>

        {!publicKey && (
          <div
            className="mb-8 rounded-lg border border-zinc-800 bg-zinc-950 p-4"
            aria-hidden="true"
          >
            <p className="text-[11px] uppercase tracking-wider text-zinc-400">
              Example scan. Your accounts appear here
            </p>
            <div className="mt-2 space-y-1 font-mono text-[11px] leading-relaxed text-zinc-400">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex items-start gap-2">
                  <span className="mt-[2px] inline-block h-3 w-3 rounded-sm border border-zinc-700 bg-emerald-500/30" />
                  <span>7kPqX…9mZ2 · mint 4dTvN…xW5a</span>
                </span>
                <span className="whitespace-nowrap text-zinc-400">
                  0.002039 SOL
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex items-start gap-2">
                  <span className="mt-[2px] inline-block h-3 w-3 rounded-sm border border-zinc-700 bg-emerald-500/30" />
                  <span>
                    2bLmR…cF8h · mint 9jKsD…pQ3e ·{" "}
                    <span className="text-sky-400/80">Token-2022</span>
                  </span>
                </span>
                <span className="whitespace-nowrap text-zinc-400">
                  0.002039 SOL
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex items-start gap-2">
                  <span className="mt-[2px] inline-block h-3 w-3 rounded-sm border border-zinc-700 bg-emerald-500/30" />
                  <span>5wNtY…vB7u · mint 6hGfA…kL1o</span>
                </span>
                <span className="whitespace-nowrap text-zinc-400">
                  0.002039 SOL
                </span>
              </div>
            </div>
            <p className="mt-2 text-emerald-400">
              +0.006117 SOL recoverable · 1 transaction
            </p>
          </div>
        )}

        {publicKey && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-sm">
            <p className="text-zinc-500">Connected:</p>
            <p className="break-all text-zinc-200">{publicKey.toBase58()}</p>
          </div>
        )}

        {/* Scan loading */}
        {publicKey && loading && (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">
            Scanning wallet...
          </div>
        )}

        {/* Scan error */}
        {publicKey && scanError && (
          <div className="mt-4 rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-400">
            <p className="font-medium">Scan failed</p>
            <p className="mt-1 text-red-400/70">{scanError}</p>
          </div>
        )}

        {/* Scan results */}
        {publicKey && !loading && !scanError && result && (
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
              <p className="text-sm text-zinc-400">
                {result.totalAccounts} token account
                {result.totalAccounts === 1 ? "" : "s"} found
              </p>
              <p className="mt-2 text-sm text-zinc-400">
                {result.eligibleAccounts.length} eligible for closing
                {selectedCount !== result.eligibleAccounts.length &&
                  ` · ${selectedCount} selected`}
              </p>
              <p className="mt-3 text-lg font-semibold text-emerald-400">
                {lamportsToSol(result.recoverableLamports)} SOL recoverable
              </p>

              {/* Itemized, selectable results. The scan is verifiable, and
                  the user chooses exactly what gets closed. Scammers
                  never offer that choice. */}
              {hasEligible && (
                <details open className="mt-3">
                  <summary className="cursor-pointer text-xs text-zinc-500 transition-colors hover:text-zinc-300">
                    Choose which accounts to close ({selectedCount} of{" "}
                    {result.eligibleAccounts.length} selected)
                  </summary>
                  <div className="mt-2 flex items-center gap-3 text-[11px]">
                    <button
                      onClick={() =>
                        setSelected(
                          new Set(result.eligibleAccounts.map((a) => a.pubkey))
                        )
                      }
                      className="text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
                    >
                      Select all
                    </button>
                    <button
                      onClick={() => setSelected(new Set())}
                      className="text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
                    >
                      Select none
                    </button>
                  </div>
                  <div className="mt-2 max-h-72 space-y-1 overflow-auto font-mono text-[11px] leading-relaxed text-zinc-500">
                    {result.eligibleAccounts.map((account) => (
                      <label
                        key={account.pubkey}
                        className="flex cursor-pointer items-baseline justify-between gap-3"
                      >
                        <span className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={selected.has(account.pubkey)}
                            onChange={() => toggleSelected(account.pubkey)}
                            className="mt-[2px] accent-emerald-500"
                          />
                          <span className="break-all">
                            <AccountLink address={account.pubkey} />
                            {" · "}
                            <AccountLink
                              address={account.mint}
                              label="mint"
                            />
                            {account.program === "token-2022" && (
                              <span className="text-sky-400/80">
                                {" "}
                                · Token-2022
                              </span>
                            )}
                          </span>
                        </span>
                        <span className="whitespace-nowrap text-zinc-400">
                          {lamportsToSol(BigInt(account.lamports))} SOL
                        </span>
                      </label>
                    ))}
                  </div>
                </details>
              )}

              {result.skippedAccounts.length > 0 && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-xs text-zinc-500 transition-colors hover:text-zinc-300">
                    {result.skippedAccounts.length} skipped, kept safe, with
                    reasons
                  </summary>
                  <div className="mt-2 max-h-72 space-y-1 overflow-auto font-mono text-[11px] leading-relaxed text-zinc-500">
                    {result.skippedAccounts.map((account) => (
                      <div
                        key={account.pubkey}
                        className="flex items-baseline justify-between gap-3"
                      >
                        <span className="break-all">
                          <AccountLink address={account.pubkey} />
                          {account.program === "token-2022" && (
                            <span className="text-sky-400/80">
                              {" "}
                              · Token-2022
                            </span>
                          )}
                        </span>
                        <span className="whitespace-nowrap text-amber-500/70">
                          {account.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>

            {result.eligibleAccounts.length === 0 &&
              result.totalAccounts > 0 && (
                <p className="text-sm text-zinc-400">
                  Your wallet has token accounts, but none are eligible for
                  closing right now.
                </p>
              )}

            {result.totalAccounts === 0 && (
              <p className="text-sm text-zinc-400">
                No token accounts found. This wallet is already clean.
              </p>
            )}

            {/* Repair button, only shown when there are eligible accounts */}
            {hasEligible && !confirming && status === "idle" && (
              <>
                <button
                  onClick={() => setConfirming(true)}
                  disabled={selectedCount === 0}
                  className="w-full rounded-lg bg-[#14F195] px-4 py-3 font-medium text-black transition-colors hover:bg-[#0fd584] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Repair Wallet
                </button>
                {selectedCount === 0 && (
                  <p className="text-xs text-zinc-500">
                    Select at least one account above to repair.
                  </p>
                )}
              </>
            )}

            {/* Confirmation screen, shown after clicking Repair */}
            {confirming && status === "idle" && (
              <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-4">
                <p className="text-sm font-medium text-zinc-200">
                  Review before you sign
                </p>
                <p className="mt-2 text-sm text-zinc-400">
                  You are about to approve{" "}
                  {batchCount === 1
                    ? "1 transaction"
                    : `${batchCount} transactions`}{" "}
                  closing {selectedCount} empty token account
                  {selectedCount === 1 ? "" : "s"}.
                </p>

                <div className="mt-3 space-y-1 rounded-md border border-zinc-800 bg-black/40 p-3 font-mono text-xs text-zinc-400">
                  <p>Accounts being closed: {selectedCount}</p>
                  <p>
                    Total SOL returning to your wallet: ~
                    {lamportsToSol(selectedLamports)} SOL
                  </p>
                  <p>
                    Network fee: ~
                    {lamportsToSol(5000n * BigInt(batchCount))} SOL base (
                    {batchCount} × 0.000005), plus any priority fee your wallet
                    adds when signing, all to the Solana network, not to us
                  </p>
                  <p>
                    Service fee (1% of recovered): ~
                    {lamportsToSol(serviceFeeLamports)} SOL, one transfer to
                    the published fee address
                  </p>
                </div>

                <p className="mt-3 text-xs font-medium text-emerald-400">
                  No tokens are moved, ever. The only SOL that leaves your
                  wallet is the 1% service fee, shown in your wallet before
                  you approve.
                </p>

                {/* Raw transaction inspector: prove what will be signed. */}
                <details className="mt-3 rounded-md border border-zinc-800 p-3">
                  <summary className="cursor-pointer text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                    Inspect exactly what you&rsquo;ll sign
                  </summary>
                  <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                    Every transaction contains closeAccount instructions
                    (classic Token Program or Token-2022, matching each
                    account) plus one transfer for the 1% service fee to the
                    published fee address. No token approvals, no authority
                    changes, nothing else. Rent goes back to your own
                    address.
                    {batchCount > 1 &&
                      ` Showing the first of ${batchCount} transactions.`}
                  </p>
                  {firstBatchPreview && (
                    <pre className="mt-2 max-h-64 overflow-auto rounded bg-black p-2 font-mono text-[10px] leading-relaxed text-zinc-500">
                      {JSON.stringify(firstBatchPreview, null, 2)}
                    </pre>
                  )}
                </details>

                {/* Optional pre-sign simulation: strongest pre-sign proof. */}
                <div className="mt-3">
                  <button
                    onClick={runSimulation}
                    disabled={sim.state === "running"}
                    className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
                  >
                    {sim.state === "running"
                      ? "Simulating on-chain..."
                      : "Run pre-sign simulation"}
                  </button>
                  {sim.state === "ok" && (
                    <p className="mt-2 text-xs leading-relaxed text-emerald-400">
                      Simulation passed on all {sim.txCount} transaction
                      {sim.txCount === 1 ? "" : "s"}. Expected net: +
                      {sim.netSol} SOL to your wallet after the network fee
                      and the 1% service fee.
                      (Your wallet may add a priority fee when signing.)
                    </p>
                  )}
                  {sim.state === "error" && (
                    <p className="mt-2 text-xs leading-relaxed text-red-400">
                      Simulation failed: {sim.error}
                    </p>
                  )}
                </div>
                <div className="mt-4 flex gap-3">
                  <button
                    onClick={() => repair(selectedAccounts)}
                    disabled={selectedCount === 0}
                    className="flex-1 rounded-lg bg-[#14F195] px-4 py-2.5 font-medium text-black transition-colors hover:bg-[#0fd584] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Approve &amp; Repair
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    className="rounded-lg border border-zinc-700 px-4 py-2.5 text-zinc-400 transition-colors hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Transaction in progress */}
            {(status === "building" ||
              status === "awaiting-signature" ||
              status === "sending" ||
              status === "verifying") && (
              <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-4">
                <p className="text-sm text-zinc-300">
                  {status === "building" &&
                    (progress && progress.total > 1
                      ? `Preparing transaction ${progress.current} of ${progress.total}...`
                      : "Building transaction...")}
                  {status === "awaiting-signature" &&
                    (progress && progress.total > 1
                      ? `Check your wallet and approve transaction ${progress.current} of ${progress.total}.`
                      : "Check your wallet. Phantom is asking you to approve.")}
                  {status === "sending" && "Sending to the network..."}
                  {status === "verifying" &&
                    "Verifying the result on the blockchain..."}
                </p>
              </div>
            )}

            {/* Success */}
            {status === "done" && signature && (
              <div className="rounded-lg border border-emerald-800 bg-emerald-950/30 p-4">
                <p className="text-sm font-medium text-emerald-400">
                  Wallet repaired
                </p>
                <p className="mt-2 text-sm text-zinc-400">
                  {closedCount} account{closedCount === 1 ? "" : "s"} closed.
                  Recovered {lamportsToSol(recoveredLamports)} SOL.
                </p>
                {signatures.map((sig) => (
                  <ExplorerLink key={sig} signature={sig} />
                ))}
                {signatures.length > 1 && (
                  <p className="text-xs text-zinc-500">
                    Completed in {signatures.length} transactions.
                  </p>
                )}
                <div className="mt-4">
                  <button
                    onClick={() => {
                      reset();
                      setConfirming(false);
                      rescan();
                    }}
                    className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}

            {/* Error */}
            {status === "error" && (
              <div className="rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-400">
                <p className="font-medium">Repair failed</p>
                <p className="mt-1 text-red-400/70">{repairError}</p>
                <button
                  onClick={() => {
                    reset();
                    setConfirming(false);
                    rescan();
                  }}
                  className="mt-3 rounded-lg border border-zinc-700 px-4 py-2 text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        )}

        <footer className="mt-12 border-t border-zinc-900 pt-6 text-xs leading-relaxed text-zinc-600">
          <p>
            Built with @solana/spl-token CloseAccount instructions. Read-only
            connection. Every transaction is signed by you, in your own
            wallet, and rent is returned to your own address.
          </p>
          <p className="mt-2">
            Works with Phantom, Solflare, Backpack, and other Wallet Standard
            wallets.
          </p>
          <p className="mt-2">
            <Link
              href="/terms"
              className="underline underline-offset-2 hover:text-zinc-400"
            >
              Terms of Service
            </Link>
            {" · "}
            <Link
              href="/privacy"
              className="underline underline-offset-2 hover:text-zinc-400"
            >
              Privacy Policy
            </Link>
            {" · "}
            <a
              href="https://github.com/sol-repair/sol.repair"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-zinc-400"
            >
              GitHub
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}
