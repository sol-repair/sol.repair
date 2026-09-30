"use client";

/**
 * Wallet health report (queue item 4, the read-only funnel). It reuses
 * the homepage's scan hook and the inspection summary component, adds no
 * actions, and never asks for a signature: the report describes what the
 * scan saw and sends every action back to the home page.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";

import { NetworkBadge } from "@/components/NetworkBadge";
import { WalletButton } from "@/components/WalletButton";
import { WalletStateSummary } from "@/components/WalletStateSummary";
import { useWalletScan } from "@/hooks/useWalletScan";
import { summarizeWalletState } from "@/lib/solana/walletInspection";
import { lamportsToSol } from "@/lib/solana/tokenAccounts";

export default function ReportPage() {
  const { publicKey } = useWallet();
  const { loading, result, error: scanError, rescan } = useWalletScan();
  const inspection = useMemo(
    () => (result ? summarizeWalletState(result) : null),
    [result]
  );

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-2xl">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-y-2">
          <span className="font-mono text-sm text-zinc-400">SOL.repair</span>
          <div className="flex flex-wrap items-center gap-4">
            <NetworkBadge />
            <Link
              href="/"
              className="text-sm text-zinc-400 hover:text-zinc-300"
            >
              &larr; Back
            </Link>
          </div>
        </div>

        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-50">
          Wallet health report
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-zinc-400">
          Connect to read your wallet&rsquo;s token accounts and see the
          whole picture on one page. Read-only: this page never asks you to
          sign anything and nothing here moves funds. Every action lives on
          the home page.
        </p>

        <div className="mb-8">
          <WalletButton />
        </div>

        {!publicKey && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
            <p className="text-[11px] uppercase tracking-wider text-zinc-400">
              What this page reads
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-zinc-400">
              <li>
                Every SPL Token and Token-2022 account owned by the
                connected wallet, at the network&rsquo;s finalized view.
              </li>
              <li>
                Which accounts are empty and closable, and how much rent
                they hold.
              </li>
              <li>
                Which accounts hold tokens, carry delegations, are frozen,
                or could not be read.
              </li>
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-zinc-400">
              It does not read your SOL balance, stake accounts, or
              transaction history.
            </p>
          </div>
        )}

        {publicKey && loading && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">
            Reading your wallet...
          </div>
        )}

        {publicKey && scanError && (
          <div className="rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-400">
            <p className="font-medium">Scan failed</p>
            <p className="mt-1 text-red-400">{scanError}</p>
            <button
              onClick={rescan}
              className="mt-3 rounded-lg border border-zinc-700 px-4 py-2 text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Scan again
            </button>
          </div>
        )}

        {publicKey && !loading && !scanError && result && (
          <div className="space-y-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
              <p className="text-sm text-zinc-400">
                {result.totalAccounts} token account
                {result.totalAccounts === 1 ? "" : "s"} found
              </p>
              <p className="mt-2 text-sm text-zinc-400">
                {result.eligibleAccounts.length} eligible for closing
              </p>
              <p className="mt-3 text-lg font-semibold text-emerald-400">
                {lamportsToSol(result.recoverableLamports)} SOL recoverable
              </p>
              {inspection && <WalletStateSummary summary={inspection} />}
            </div>
            <p className="text-sm leading-relaxed text-zinc-400">
              Closing empty accounts, revoking delegations, and unwrapping
              wrapped SOL all happen on the home page. This page only reads.
            </p>
            <Link
              href="/"
              className="flex w-full items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              Open the repair tool &rarr;
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
