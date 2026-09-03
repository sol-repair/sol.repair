import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How to close empty token accounts | SOL.repair",
  description:
    "Closing an empty Solana token account returns its rent deposit to your wallet. Exactly what the instruction does, and how to check any tool before you use it.",
  alternates: { canonical: "/guides/close-token-accounts" },
};

export default function CloseTokenAccountsGuide() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center justify-between">
          <span className="font-mono text-sm text-zinc-500">SOL.repair</span>
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
            ← Back
          </Link>
        </div>

        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-50">
          How to close empty token accounts
        </h1>

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              What closing actually does
            </h2>
            <p>
              A token account is a small record on the chain that ties your
              wallet to one specific token. When it is empty, it serves no
              purpose, but it still holds its rent deposit. Closing the
              account is one instruction, called closeAccount. It deletes the
              record and sends the deposit to a destination address. One
              instruction, one signature, and the SOL is back in your wallet
              in the same transaction.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">Two ways to do it</h2>
            <p>
              By hand. The Solana CLI can send a closeAccount instruction to
              any token account you own. It works, and apart from the network
              fee it is free. For one or two accounts it is reasonable. For
              twenty, most people do not want to.
            </p>
            <p className="mt-2">
              With a tool. A batch tool builds the same instruction for every
              empty account and groups them into transactions. Fewer
              approvals, same result. This site is one of those tools.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              What closing never does
            </h2>
            <p>
              It never touches a token balance. An account holding tokens
              cannot be closed; the network rejects it. It never needs your
              seed phrase, on this site or any honest one. And it never moves
              SOL anywhere except to the destination you approve, which
              should be your own address.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              How to check any tool before you use it
            </h2>
            <p>
              Ours included. Look at the destination address on the close
              instruction before you sign. It should be yours. Look at what
              else the transaction does. A rent recovery transaction contains
              closeAccount instructions and nothing exotic. If a site asks for
              your seed phrase, leave. No real tool needs it.
            </p>
            <p className="mt-2">
              You can also simulate first. This site runs a free simulation of
              the actual transaction before you sign, so you can watch it fail
              or succeed without spending anything.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">What we charge</h2>
            <p>
              One percent of what you recover, per transaction, only when it
              succeeds. If a transaction fails, there is no fee. Every fee we
              have ever collected is listed on chain.{" "}
              <Link
                href="/fees"
                className="underline underline-offset-2 hover:text-zinc-400"
              >
                See the fee ledger
              </Link>
              .
            </p>
          </section>

          <Link
            href="/"
            className="inline-block rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white"
          >
            Run the scan →
          </Link>
        </div>

        <footer className="mt-12 border-t border-zinc-900 pt-6 text-xs leading-relaxed text-zinc-400">
          <p>
            More:{" "}
            <Link
              href="/guides/random-tokens"
              className="underline underline-offset-2 hover:text-zinc-200"
            >
              Why do I have random tokens in my wallet?
            </Link>{" "}
            ·{" "}
            <Link
              href="/guides/solana-rent"
              className="underline underline-offset-2 hover:text-zinc-200"
            >
              What is Solana rent?
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
}
