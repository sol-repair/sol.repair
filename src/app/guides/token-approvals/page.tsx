import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/pageMetadata";
import { guideSchema } from "@/lib/guideSchema";
import { GuideBreadcrumb, JsonLd } from "@/components/GuideBreadcrumb";

export const metadata: Metadata = pageMetadata({
  title: "How to check and revoke Solana token approvals",
  description:
    "A Solana token approval (a delegate) lets another address move tokens out of one of your token accounts. What it can and cannot do, how to find yours, and how to revoke it.",
  path: "/guides/token-approvals",
});

const schema = guideSchema({
  title: "How to check and revoke Solana token approvals",
  description: metadata.description as string,
  path: "/guides/token-approvals",
  datePublished: "2026-09-30",
  dateModified: "2026-09-30",
});

export default function TokenApprovalsGuide() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center justify-between">
          <span className="font-mono text-sm text-zinc-400">SOL.repair</span>
          <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-300">
            ← Back
          </Link>
        </div>

        <GuideBreadcrumb title="How to check and revoke Solana token approvals" />

        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-50">
          How to check and revoke Solana token approvals
        </h1>

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <p>
              When you trade, stake, or claim on Solana, you sometimes sign a
              transaction that hands out a permission: you let another address
              move a specific token out of a specific one of your token
              accounts, up to an amount you chose. That permission is called a
              delegate. Wallets and explorers may also call it an approval.
              This page explains what it is, what it can and cannot do, and
              how to clear it. Nothing here needs your seed phrase, on this
              site or any honest one.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              What an approval actually is
            </h2>
            <p>
              On Solana, every token you hold sits in its own token account,
              a small on-chain record that ties one mint to your wallet. The
              Approve instruction writes one extra field onto that record: a
              delegate address and a delegated amount. The instruction runs
              on one token account. It is not a permission on your wallet as
              a whole, and it is not a permission on your other tokens.
            </p>
            <p className="mt-2">
              If you have used Ethereum or other EVM chains, the closest
              comparison is an ERC-20 approval, but scoped tighter: per token
              account rather than per wallet.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              What a delegate can do
            </h2>
            <p>
              A delegate can transfer or burn tokens from that one account,
              up to the delegated amount, without asking you again. That is
              the whole list. It exists so a program can act for you when you
              ask it to, for example settling a trade you agreed to.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              What a delegate cannot do
            </h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>It cannot move SOL or any token from your other token
                accounts. Each approval lives on exactly one account.</li>
              <li>It cannot take more than the amount that was approved.</li>
              <li>It cannot spend from an account that holds nothing. An
                empty account has nothing to take.</li>
              <li>It cannot extend itself or grant itself anything new.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Why a stale approval matters
            </h2>
            <p>
              An approval you granted months ago is still on the account
              today. Nothing expires it. If the protocol you approved is ever
              compromised, or you approved something you did not mean to,
              that permission is what gets used. This is why people make a
              habit of revoking approvals they no longer need. A revoke is
              one small transaction: it clears the delegate and resets the
              delegated amount to zero. Closing the token account also ends
              any delegation on it, because the whole record is deleted.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Connected apps are not token approvals
            </h2>
            <p>
              Phantom and other wallets keep a list of connected apps in
              their settings. That list is a session between your wallet and
              a website: it controls whether the site can prompt you, not
              what the chain allows. A delegate is on-chain data on your
              token account. Disconnecting a site cannot change on-chain
              data, the same way closing a tab cannot change a bank record.
              Tidying your connected-apps list is good hygiene, but it does
              not revoke token approvals. Those are a separate list, cleared
              by a separate action.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">How to see yours</h2>
            <p>
              Three honest ways. Some wallets show a delegate on a token
                account&apos;s detail screen, so open the token and look for a
              mention of a delegate, an approved spender, or a delegated
              amount. An explorer like Solscan shows the delegate field when
              you open the token account itself. And this site has a
              read-only option: open the{" "}
              <Link
                href="/report"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                wallet health report
              </Link>
              , connect to scan, and delegated accounts are listed as an
              active delegation. Reading never signs anything.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              How to revoke one
            </h2>
            <p>
              With a dedicated tool. If the account still holds tokens and
              you want to keep it, an approval-revoking tool is the right
              instrument.{" "}
              <a
                href="https://revoke.cash"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                Revoke.cash
              </a>{" "}
              is the established one and supports Solana, and{" "}
              <a
                href="https://sol-incinerator.com/revoke"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                Solana Incinerator
              </a>{" "}
              has a revoke page. Read what each one shows you before you
              sign, and check their fee terms on their own pages.
            </p>
            <p className="mt-2">
              From the command line. The spl-token CLI has a revoke
              subcommand for token accounts you own. Run
              spl-token --help for the exact syntax on your version.
            </p>
            <p className="mt-2">
              On this site. The scan offers a revoke action for delegated
              accounts that hold a balance: one account at a time, with your
              consent per account. Empty delegated accounts do not need a
              separate step; the repair clears the delegate and closes the
              account in the same transaction.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              What this site does and does not handle
            </h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Funded accounts with an active delegate: a per-account revoke
                action, one at a time. You approve each transaction.
              </li>
              <li>
                Empty delegated accounts: revoke plus close together, inside
                the repair.
              </li>
              <li>
                Frozen delegated accounts: listed read-only. The network
                rejects revoking a frozen account, so the page reports rather
                than pretends.
              </li>
              <li>
                A dashboard sweep of many approvals in one go: not what this
                site is. If you want to review every approval across your
                wallet in one place, Revoke.cash is genuinely the better
                tool for that job.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Checking what you signed
            </h2>
            <p>
              If you are unsure whether a past transaction granted a
              permission, you can read it. Paste any transaction signature
              into the{" "}
              <Link
                href="/understand"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                transaction explainer
              </Link>{" "}
              and it names every lasting change the transaction made,
              including approvals. The steps for closing the accounts
              themselves are in{" "}
              <Link
                href="/guides/close-token-accounts"
                className="underline underline-offset-2 hover:text-zinc-100"
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
              href="/guides/close-token-accounts"
              className="underline underline-offset-2 hover:text-zinc-200"
            >
              How to close empty token accounts
            </Link>{" "}
            ·{" "}
            <Link
              href="/guides/what-did-i-just-sign"
              className="underline underline-offset-2 hover:text-zinc-200"
            >
              What did I just sign?
            </Link>
          </p>
        </footer>
      </div>
      <JsonLd data={schema} />
    </main>
  );
}
