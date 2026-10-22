/**
 * PreConnectInfo: the four information blocks a first-time visitor sees
 * before connecting a wallet - what connecting exposes, how the repair
 * works, an example scan, and what SOL.repair cannot do.
 *
 * Extracted verbatim from the homepage so the pre-connect page can
 * render these blocks both before the lazy wallet app mounts (the
 * connect boundary's placeholder state) and after it (the app renders
 * them itself while no wallet is connected). Pure static markup: no
 * wallet imports, no state, so the shell can render it without
 * touching the wallet chunk.
 */

export function PreConnectInfo() {
  return (
    <>
      <div className="mb-8 text-xs leading-relaxed text-zinc-400">
        <p>
          Connecting only lets the site read your wallet address and its
          token accounts.
        </p>
        <p className="mt-1">
          On your phone, open this page inside the Phantom app (the
          globe icon at the bottom).
        </p>
      </div>

      <section id="how-it-works" className="mb-10 scroll-mt-6">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-zinc-400">
          <span aria-hidden="true" className="text-zinc-400">01</span>{" "}
          <span className="text-emerald-400">How it works</span>
        </h2>
        <ol className="mt-3 space-y-2 text-sm leading-relaxed text-zinc-300">
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="shrink-0 font-mono text-xs leading-6 text-zinc-400"
            >
              1
            </span>
            <span>Connect to scan. No transaction is signed.</span>
          </li>
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="shrink-0 font-mono text-xs leading-6 text-zinc-400"
            >
              2
            </span>
            <span>
              Review your scan: each empty account and the SOL locked in
              it.
            </span>
          </li>
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="shrink-0 font-mono text-xs leading-6 text-zinc-400"
            >
              3
            </span>
            <span>Pick the accounts and check the fee.</span>
          </li>
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="shrink-0 font-mono text-xs leading-6 text-zinc-400"
            >
              4
            </span>
            <span>Approve each transaction yourself.</span>
          </li>
        </ol>
      </section>

      <section className="mb-10" aria-hidden="true">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-zinc-400">
          <span aria-hidden="true" className="text-zinc-400">02</span>{" "}
          <span className="text-emerald-400">Example scan</span>
        </h2>
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <div className="mt-2 space-y-1 font-mono text-[11px] leading-relaxed text-zinc-400">
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <span className="flex items-start gap-2">
                <span className="mt-[2px] inline-block h-3 w-3 rounded-sm border border-zinc-700 bg-emerald-500/30" />
                <span>7kPqX…9mZ2 · mint 4dTvN…xW5a</span>
              </span>
              <span className="whitespace-nowrap text-zinc-400">
                0.002039 SOL
              </span>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <span className="flex items-start gap-2">
                <span className="mt-[2px] inline-block h-3 w-3 rounded-sm border border-zinc-700 bg-emerald-500/30" />
                <span>
                  2bLmR…cF8h · mint 9jKsD…pQ3e ·{" "}
                  <span className="text-sky-400/80">Token-2022</span>
                  {" · "}
                  <span className="text-sky-400/80">revoke + close</span>
                </span>
              </span>
              <span className="whitespace-nowrap text-zinc-400">
                0.002074 SOL
              </span>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <span className="flex items-start gap-2">
                <span className="mt-[2px] inline-block h-3 w-3 rounded-sm border border-zinc-700 bg-emerald-500/30" />
                <span>5wNtY…vB7u · mint 6hGfA…kL1o</span>
              </span>
              <span className="whitespace-nowrap text-zinc-400">
                0.001488 SOL
              </span>
            </div>
          </div>
          <p className="mt-2 text-emerald-400">
            0.005601 SOL recoverable · 1 transaction
          </p>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-zinc-400">
          <span aria-hidden="true" className="text-zinc-400">03</span>{" "}
          <span className="text-emerald-400">
            What SOL.repair cannot do
          </span>
        </h2>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-zinc-300">
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="shrink-0 font-mono text-xs leading-6 text-zinc-400"
            >
              1
            </span>
            <span>Access your private key or seed phrase.</span>
          </li>
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="shrink-0 font-mono text-xs leading-6 text-zinc-400"
            >
              2
            </span>
            <span>Move your funds without a transaction you approve.</span>
          </li>
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="shrink-0 font-mono text-xs leading-6 text-zinc-400"
            >
              3
            </span>
            <span>Close an account the on-chain authority does not allow.</span>
          </li>
        </ul>
      </section>
    </>
  );
}
