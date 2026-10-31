import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/pageMetadata";
import { guideSchema } from "@/lib/guideSchema";
import { GuideBreadcrumb, JsonLd } from "@/components/GuideBreadcrumb";
import { SiteHeader } from "@/components/SiteHeader";
import { GuideToc } from "@/components/GuideToc";

export const metadata: Metadata = pageMetadata({
  title: "What did I just sign?",
  description:
    "How to read a Solana transaction: the instructions it runs, and the lasting permissions it can leave behind. Plus how to check any transaction yourself.",
  path: "/guides/what-did-i-just-sign",
});

const schema = guideSchema({
  title: "What did I just sign?",
  description: metadata.description as string,
  path: "/guides/what-did-i-just-sign",
  datePublished: "2026-09-19",
  dateModified: "2026-10-31",
});

export default function WhatDidIJustSignGuide() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <SiteHeader active="guides" />

        <GuideBreadcrumb title="What did I just sign?" />

        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-50">
          What did I just sign?
        </h1>

        <GuideToc
          items={[
            { href: "#instructions-are-just-steps", label: "Instructions are just steps" },
            { href: "#the-part-people-miss-lasting-permissions", label: "The part people miss: lasting permissions" },
            { href: "#wallets-add-their-own-instructions", label: "Wallets add their own instructions" },
            { href: "#reading-one-yourself", label: "Reading one yourself" },
            { href: "#the-rules-that-tool-follows", label: "The rules that tool follows" },
          ]}
        />

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
            <h2 id="instructions-are-just-steps" className="mb-2 text-lg font-semibold text-zinc-50">Instructions are just steps</h2>
            <p>
              Every transaction is a short list of steps: send SOL, move a
              token, create an account, close an account, change a setting.
              A swap is a few steps. Creating a token account is a few
              steps. Reading the list in order tells you exactly what
              happened, with no interpretation needed.
            </p>
          </section>

          <section>
            <h2 id="the-part-people-miss-lasting-permissions" className="mb-2 text-lg font-semibold text-zinc-50">The part people miss: lasting permissions</h2>
            <p>
              Some instructions move nothing at all. They hand out
              permission. Approving a token lets another address spend from
              your account. Changing an authority hands ownership or
              control to a different address. Freezing locks an account
              until the freeze authority unlocks it. Your balance does not
              change when any of that happens, so the only way to notice is
              to read the transaction itself. If you want to go deeper on
              the approval case specifically, and how to clear approvals
              you no longer want,{" "}
              <Link
                href="/guides/token-approvals"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                the token approvals guide
              </Link>{" "}
              covers it.
            </p>
            <p className="mt-2">
              This is why a transaction from months ago can still matter
              today: a permission you approved back then can still be
              sitting there.
            </p>
          </section>

          <section>
            <h2 id="wallets-add-their-own-instructions" className="mb-2 text-lg font-semibold text-zinc-50">Wallets add their own instructions</h2>
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
            <h2 id="reading-one-yourself" className="mb-2 text-lg font-semibold text-zinc-50">Reading one yourself</h2>
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
            <h2 id="the-rules-that-tool-follows" className="mb-2 text-lg font-semibold text-zinc-50">The rules that tool follows</h2>
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
      <JsonLd data={schema} />
    </main>
  );
}
