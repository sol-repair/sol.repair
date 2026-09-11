'use client';

// Route error boundary: without it, any render-time crash anywhere in a
// page white-screens the route with no recovery path. This is the site's
// own voice for that case, not a stack trace. The framework hands the
// boundary { error, retry } (see the bundled error.js file-convention
// doc; this Next retries the segment, it does not expose reset()).
//
// The copy draws the one line that matters for a wallet tool: a render
// crash cannot sign or send. It deliberately does NOT claim a running
// repair was harmless — a transaction already signed is on chain, so
// the honest recovery is the rescan.

import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Keep the real stack in the console: the fallback tells the user
    // what to do, the console tells support what happened.
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">
        This page hit an unexpected error.
      </h1>
      <p className="mt-4 text-zinc-300">
        The failure was in the page itself, not in your wallet: nothing
        was signed or sent by this error. If a repair was in flight, scan
        your wallet again to see where it stands.
      </p>
      <p className="mt-3 text-sm text-zinc-400">
        If this keeps happening, tell us:{" "}
        <a
          href="mailto:admin@sol.repair"
          className="text-zinc-200 underline decoration-zinc-600 underline-offset-2 hover:decoration-zinc-300"
        >
          admin@sol.repair
        </a>
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="mt-8 rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-900"
      >
        Try again
      </button>
    </main>
  );
}
