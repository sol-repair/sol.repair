"use client";

/**
 * Fee ledger page. Every 1% fee the tool has charged, straight from chain
 * data, fetched in the browser against the public RPC. No backend, no
 * server-side cache; every row links to the transaction so anyone can
 * verify it independently.
 */

import { useState } from "react";
import Link from "next/link";
import { NetworkBadge } from "@/components/NetworkBadge";
import { useFeeLedger } from "@/hooks/useFeeLedger";
import {
  formatBlockTime,
  formatLamportsSol,
  type FeeLedgerCluster,
} from "@/lib/solana/feeLedger";

const CLUSTERS: FeeLedgerCluster[] = ["mainnet-beta", "devnet"];

/** Explorer link for a transaction, cluster-aware the same way the home
 *  page's links are. */
function explorerUrl(cluster: FeeLedgerCluster, signature: string): string {
  const base = `https://solscan.io/tx/${signature}`;
  return cluster === "devnet" ? `${base}?cluster=devnet` : base;
}

/** Short form for on-chain identifiers, matching the home page's
 *  convention; the full signature stays in the title tooltip and the
 *  Solscan link. */
function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Honest age label, computed from the actual fetch time. */
function updatedAgo(fetchedAt: number | null, now: number): string {
  if (fetchedAt == null) return "—";
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

export default function FeesPage() {
  const {
    cluster,
    setCluster,
    rows,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    reload,
    fetchedAt,
    now,
    feeWallet,
    totalLamports,
  } = useFeeLedger();
  const [copied, setCopied] = useState(false);

  const copyFeeWallet = async () => {
    try {
      await navigator.clipboard.writeText(feeWallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (permissions, http). Nothing to show;
      // the address is right there to select.
    }
  };

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

        <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
          Fee Ledger
        </p>
        <h1 className="mb-3 text-3xl font-semibold tracking-tight text-zinc-50">
          Every fee we&rsquo;ve ever collected.
        </h1>
        <p className="mb-6 text-zinc-400">
          The 1% success fee, straight from chain data. This page runs in
          your browser — no backend, nothing cached on a server. Every row
          links to the transaction, so you can verify every number
          yourself.
        </p>

        <div className="mb-4 flex gap-2">
          {CLUSTERS.map((c) => (
            <button
              key={c}
              onClick={() => setCluster(c)}
              className={`rounded-md border px-3 py-3 font-mono text-xs transition-colors ${
                c === cluster
                  ? "border-zinc-500 text-zinc-100"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              }`}
            >
              {c === "mainnet-beta" ? "MAINNET" : "DEVNET"}
            </button>
          ))}
        </div>

        <p className="mb-4 font-mono text-xs text-zinc-500">
          {rows.length} fee{rows.length === 1 ? "" : "s"} ·{" "}
          {formatLamportsSol(totalLamports)} SOL total · rpc {cluster} ·
          updated {updatedAgo(fetchedAt, now)}
        </p>

        {loading && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">
            Reading the chain...
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-400">
            <p className="font-medium">Ledger unavailable</p>
            <p className="mt-1 text-red-400/70">{error}</p>
            <button
              onClick={reload}
              className="mt-3 rounded-lg border border-zinc-700 px-4 py-3 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-8 text-center font-mono text-xs leading-relaxed text-zinc-500">
            <p>No fees collected yet.</p>
            <p className="mt-1 text-zinc-600">
              This table fills as people run cleanups. Nothing here is
              simulated.
            </p>
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div className="border-t border-zinc-800">
              <div className="flex items-baseline justify-between gap-3 border-b border-zinc-800 py-2 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                <span>Date (UTC)</span>
                <span className="flex-1">Tx</span>
                <span className="text-right">Amount SOL</span>
              </div>
              {rows.map((row) => (
                <a
                  key={row.signature}
                  href={explorerUrl(cluster, row.signature)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={row.signature}
                  className="group flex items-baseline justify-between gap-3 border-b border-zinc-800 py-3 font-mono text-xs transition-colors hover:bg-zinc-900/40"
                >
                  <span className="whitespace-nowrap text-zinc-500">
                    {formatBlockTime(row.blockTime)}
                  </span>
                  <span className="flex-1 truncate text-zinc-400 underline decoration-zinc-700 underline-offset-2 group-hover:text-zinc-200">
                    {short(row.signature)}
                  </span>
                  <span className="whitespace-nowrap text-right tabular-nums text-zinc-300">
                    {formatLamportsSol(row.lamports)}
                  </span>
                </a>
              ))}
            </div>

            {hasMore && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="mt-4 w-full rounded-md border border-zinc-700 px-3 py-3 font-mono text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
              >
                {loadingMore ? "Loading..." : "Load 25 more"}
              </button>
            )}
            {!hasMore && (
              <p className="mt-4 text-center font-mono text-xs text-zinc-600">
                end of ledger
              </p>
            )}
          </>
        )}

        <div className="mt-8 rounded-md border border-zinc-800 p-3 font-mono text-xs leading-relaxed text-zinc-500">
          <p className="flex items-center justify-between gap-3">
            <span className="break-all">fee wallet: {feeWallet}</span>
            <button
              onClick={copyFeeWallet}
              className="shrink-0 px-2 py-2 text-zinc-400 underline decoration-zinc-700 underline-offset-2 transition-colors hover:text-zinc-200"
            >
              {copied ? "copied" : "copy"}
            </button>
          </p>
          <p className="mt-2">
            Reproduce without this page: getSignaturesForAddress on this
            address against any Solana RPC.
          </p>
          <p className="mt-1 text-zinc-600">
            A row is a System transfer into this address that happened
            inside a repair transaction (one that also contains a
            token-program closeAccount). Seed funding is not a fee and is
            not listed.
          </p>
        </div>

        <footer className="mt-12 border-t border-zinc-900 pt-6 text-xs leading-relaxed text-zinc-600">
          <p>
            <Link
              href="/"
              className="inline-block py-2 underline underline-offset-2 hover:text-zinc-400"
            >
              ← back to the repair tool
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
}
