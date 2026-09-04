import type { Metadata } from "next";
import Link from "next/link";

import { RentCalculator } from "@/components/RentCalculator";

export const metadata: Metadata = {
  title: "What is Solana rent? | SOL.repair",
  description:
    "Solana accounts hold a rent deposit that comes back to you when the account closes. A plain explanation with real numbers and a simple calculator.",
  alternates: { canonical: "/guides/solana-rent" },
};

export default function SolanaRentGuide() {
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
          What is Solana rent?
        </h1>

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Rent is a deposit, not a fee
            </h2>
            <p>
              Solana charges for the space your accounts use on the chain. For
              token accounts, the network does not collect that rent a little
              at a time. Instead it requires a minimum balance sitting in the
              account, always enough to cover the storage. This is called
              rent-exempt. For a standard token account created before
              September 4, 2026, that minimum is 2,039,280 lamports, about
              0.00204 SOL. The network lowered the rate that day, so
              accounts created after hold 1,855,569 lamports, about 0.00186
              SOL.
            </p>
            <p className="mt-2">
              The important part: it is a deposit. It does not get spent while
              the account sits there. Close the account and the whole deposit
              comes back to the owner.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-medium text-zinc-100">
              Closing, in one picture
            </h2>
            <div className="grid gap-2 font-mono text-[11px] leading-relaxed">
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
                <span className="text-zinc-500">Empty token account</span>
                <br />
                holds about 0.002 SOL of rent
              </div>
              <div className="text-center text-zinc-600">↓</div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
                <span className="text-zinc-500">closeAccount instruction</span>
                <br />
                one instruction, you sign it
              </div>
              <div className="text-center text-zinc-600">↓</div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-zinc-300">
                <span className="text-zinc-500">Your wallet</span>
                <br />
                the rent returns to you, same transaction
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-3 font-medium text-zinc-100">
              How much is locked in yours?
            </h2>
            <RentCalculator />
            <p className="mt-3">
              This is an estimate at the standard deposit. The scan shows your
              real number, because it reads your actual accounts.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Where the number comes from
            </h2>
            <p>
              The deposit comes from a network parameter, lamports per byte,
              and the network lowers it from time to time. Mainnet lowered it
              on September 4, 2026, which is why there are two values on this
              page. If it changes again, this page changes with it.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">Getting it back</h2>
            <p>
              Closing an empty token account is one instruction. The rent goes
              to a destination address, normally your own wallet, and it lands
              in the same transaction that closes the account. The exact steps
              are in{" "}
              <Link
                href="/guides/close-token-accounts"
                className="underline underline-offset-2 hover:text-zinc-400"
              >
                how to close empty token accounts
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
              href="/guides/close-token-accounts"
              className="underline underline-offset-2 hover:text-zinc-200"
            >
              How to close empty token accounts
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
}
