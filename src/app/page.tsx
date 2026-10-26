"use client";

/**
 * Homepage shell.
 *
 * The wallet-carrying half of the page (provider, connect flow, scan,
 * repair) mounts behind a next/dynamic boundary in HomeApp: the
 * wallet-adapter bundle no longer loads with the page, only when the
 * deferred chunk arrives. Until then the page shows the pre-connect
 * shell below - headline, copy, and the full pre-connect information -
 * with a reserved placeholder where the connect button sits. The
 * placeholder is the same gray box the server render has always shown
 * for the not-yet-hydrated button; the swap from placeholder to real
 * button is the only visible transition, and the pre-connect content
 * (PreConnectInfo) is identical on both sides of it, so the page looks
 * and behaves the same before and after the chunk lands.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { PreConnectInfo } from "@/components/PreConnectInfo";
import { ToolLinksSection } from "@/components/ToolLinksSection";
import GuidesSection from "@/components/GuidesSection";
import { RECOVERED_TOTALS } from "@/lib/recoveredTotals";

const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
];

/** ISO date to "October 25, 2026". Plain string math on purpose: the
 *  result must be identical on server and client (no ICU drift). */
function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

const HomeApp = dynamic(() => import("@/components/HomeApp"), {
  ssr: false,
  loading: () => (
    <>
      {/* The connect row with the reserved-space box (the same size
          and color the server render has always shown for the button
          slot) and the how-it-works anchor beside it. */}
      <div className="mb-3 flex items-stretch gap-3">
        <div className="flex-1">
          <div
            className="h-[44px] w-full rounded-lg bg-zinc-900"
            aria-hidden="true"
          />
        </div>
        <a
          href="#how-it-works"
          className="flex items-center justify-center rounded-lg border border-zinc-700 px-4 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-900"
        >
          How it works
        </a>
      </div>
      <PreConnectInfo />
    </>
  ),
});

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-xl">
        <SiteHeader />

        <h1 className="mb-3 text-3xl font-semibold tracking-tight text-zinc-50">
          Reclaim SOL from empty token accounts.
        </h1>
        <p className="mb-2 text-zinc-300">
          Close empty SPL and Token-2022 accounts and recover the SOL held in
          them.
        </p>
        <p className="mb-4 text-zinc-300">
          100% open source. 1% success fee, only when SOL is successfully
          recovered.{" "}
          <a
            href="https://github.com/sol-repair/sol.repair"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-zinc-200"
          >
            Verify exactly what the app does in the source code
          </a>
          .
        </p>
        <p className="mb-6 font-mono text-xs leading-relaxed text-zinc-400">
          Most empty token accounts hold about 0.00149 to 0.00208 SOL,
          depending on when they were created.
          <br />
          Recovered SOL is returned to the wallet that owns the account.
        </p>
        <p className="mb-6 font-mono text-xs leading-relaxed text-zinc-400">
          Total SOL recovered through repairs and burn-closes since launch:{" "}
          {RECOVERED_TOTALS.lamportsFreedSol} SOL. As of{" "}
          {longDate(RECOVERED_TOTALS.asOf)}. Next weekly update:{" "}
          {longDate(RECOVERED_TOTALS.nextUpdate)}. The fee ledger has every
          row.
        </p>

        <HomeApp />

        <ToolLinksSection />

        <GuidesSection step="05" />

        <footer className="mt-12 border-t border-zinc-900 pt-6 text-xs leading-relaxed text-zinc-400">
          <p>
            Built with @solana/spl-token CloseAccount and Revoke
            instructions. Read-only connection. Every transaction is
            signed by you, in your own wallet, and rent is returned to
            your own address.
          </p>
          <p className="mt-2">
            Works with Phantom, Solflare, Backpack, and other Wallet Standard
            wallets.
          </p>
          <p className="mt-2">
            <Link
              href="/guides"
              className="underline underline-offset-2 hover:text-zinc-400"
            >
              Guides
            </Link>
            {" · "}
            <Link
              href="/understand"
              className="underline underline-offset-2 hover:text-zinc-400"
            >
              Understand a transaction
            </Link>
            {" · "}
            <Link
              href="/report"
              className="underline underline-offset-2 hover:text-zinc-400"
            >
              Health report
            </Link>
            {" · "}
            <Link
              href="/changelog"
              className="underline underline-offset-2 hover:text-zinc-400"
            >
              Changelog
            </Link>
            {" · "}
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
