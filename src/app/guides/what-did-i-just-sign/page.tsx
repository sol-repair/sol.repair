import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "What did I just sign? | SOL.repair",
  description:
    "How to read a Solana transaction: the instructions it runs, and the lasting permissions it can leave behind. Plus how to check any transaction yourself.",
  alternates: { canonical: "/guides/what-did-i-just-sign" },
};

export default function WhatDidIJustSignGuide() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center justify-between">
          <span className="font-mono text-sm text-zinc-400">SOL.repair</span>
          <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-300">
            ← Back
          </Link>
        </div>

        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-50">
          What did I just sign?
        </h1>

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <p>
              A transaction is a list of instructions, and the network runs
              them in order. If any one of them fails, none of them take
              effect. That part is simple. The part that catches people
              last is not what a transaction did for you, but what it left
              behind.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Instructions are just steps
            </h2>
            <p>
              Every transaction is a short list of steps: send SOL, move a
              token, create an account, close an account, change a setting.
              A swap is a few steps. Creating a token account is a few
              steps. Reading the list in order tells you exactly what
              happened, with no interpretation needed.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              The part people miss: lasting permissions
            </h2>
            <p>
              Some instructions move nothing at all. They hand out
              permission. Approving a token lets another address spend from
              your account. Changing an authority hands ownership or
              control to a different address. Freezing locks an account
              until the freeze authority unlocks it. Your balance does not
              change when any of that happens, so the only way to notice is
              to read the transaction itself.
            </p>
            <p className="mt-2">
              This is why a transaction from months ago can still matter
              today: a permission you approved back then can still be
              sitting there.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Wallets add their own instructions
            </h2>
            <p>
              Wallets add their own instructions when you sign, for example
              fee settings, and in Phantom&rsquo;s case safety checks that
              make the transaction abort unless the outcome matches what
              you approved. Those come from the wallet, not from the app
              you used, and a tool that cannot describe them should say so
              plainly rather than guess.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Reading one yourself
            </h2>
            <p>
              Paste any transaction signature into the explainer on this
              site, or connect a wallet read-only to list its recent
              transactions. The panel above the instruction list names
              every lasting change: which permissions now exist, who holds
              them, and what ended. The instruction list below it is the
              raw breakdown, in order. Anything the tool cannot describe
              says so instead of guessing.
            </p>
            <p className="mt-3">
              <Link
                href="/understand"
                className="underline underline-offset-2 hover:text-white"
              >
                Open the explainer
              </Link>
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              The rules that tool follows
            </h2>
            <p>
              It describes, it does not accuse. There is exactly one case
              marked red: a transaction that hands ownership of a token
              account to a different address, which is almost never what a
              wallet user means to do. Everything else is stated as fact
              and left for you to judge. The page never connects a wallet
              for signing and never asks for an approval.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
