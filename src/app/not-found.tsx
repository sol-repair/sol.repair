import Link from "next/link";
import { NetworkBadge } from "@/components/NetworkBadge";

// Root not-found: without this file the framework default renders a bare
// "404" with no way back into the site, which on a phone is a dead end.
// The page makes no wallet or RPC requests, and the copy says so: a
// mistyped address cannot touch anything.
export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-2xl">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-y-2">
          <span className="font-mono text-sm text-zinc-400">SOL.repair</span>
          <NetworkBadge />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
          404
        </h1>
        <p className="mt-2 text-zinc-300">
          This page could not be found. The address may be mistyped, or the
          page may have moved.
        </p>
        <p className="mt-2 text-sm text-zinc-400">
          Nothing was requested from your wallet.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-900"
        >
          Back to the repair tool
        </Link>
      </div>
    </main>
  );
}
