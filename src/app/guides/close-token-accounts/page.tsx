import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/pageMetadata";
import { guideSchema } from "@/lib/guideSchema";
import { GuideBreadcrumb, JsonLd } from "@/components/GuideBreadcrumb";

export const metadata: Metadata = pageMetadata({
  title: "How to close empty token accounts",
  description:
    "Closing an empty Solana token account returns its rent deposit to your wallet. Every route: wallet built-ins, the CLI, and web tools, plus Token-2022, delegated accounts, and how to check any tool first.",
  path: "/guides/close-token-accounts",
});

const schema = guideSchema({
  title: "How to close empty token accounts",
  description: metadata.description as string,
  path: "/guides/close-token-accounts",
  datePublished: "2026-09-03",
  dateModified: "2026-09-30",
});

export default function CloseTokenAccountsGuide() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center justify-between">
          <span className="font-mono text-sm text-zinc-400">SOL.repair</span>
          <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-300">
            ← Back
          </Link>
        </div>

        <GuideBreadcrumb title="How to close empty token accounts" />

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
            <p className="mt-2">
              How much is in there depends on when the account was created:
              about 0.00149 to 0.00208 SOL today. The{" "}
              <Link
                href="/guides/solana-rent"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                rent guide
              </Link>{" "}
              explains the numbers, and the 2026 rate cuts created a second
              way to recover deposit SOL, covered in{" "}
              <Link
                href="/guides/rent-reduction"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                the rent reduction page
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Three ways to do it
            </h2>
            <p>
              Your wallet. Some wallets, including Phantom and Solflare,
              can close empty token accounts from their own settings or
              token screens. If yours offers it and you have a handful of
              accounts, this is the simplest route: no third-party site,
              no service fee, only the network fee.
            </p>
            <p className="mt-2">
              The command line. The spl-token CLI can close any token
              account you own. List what you have with spl-token accounts,
              close one with spl-token close followed by the mint, or use
              spl-token gc --close-empty-associated-accounts to clean up
              every empty associated account at once. The current CLI
              handles both the classic Token Program and Token-2022.
              Apart from the network fee it is free. For one or two
              accounts it is reasonable. For twenty, most people do not
              want to.
            </p>
            <p className="mt-2">
              A web tool. A batch tool builds the same closeAccount
              instruction for every empty account and groups them into
              transactions. Fewer approvals, same result. Web tools charge
              a service fee on top of the network fee, and the fee is where
              they differ: some state it on the page, some only show it
              inside the transaction you are about to sign. If a tool does
              not say what it charges before you connect, treat that as
              information. This site is one of those tools.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Accounts that cannot be closed
            </h2>
            <p>
              The network rejects closing an account that holds any token
              balance at all, even a fraction of a cent of dust. Nothing
              gets around that rule; an honest tool skips those accounts
              and shows you why. You have three options for a dust
              balance: send the tokens to an address that wants them, burn
              them, or leave the account alone. Burning destroys the
              balance permanently and is not undoable, so it is worth a
              thought first. This site can burn and close dust accounts in
              one step, with your approval per account.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Token-2022 accounts
            </h2>
            <p>
              There are two token programs on Solana: the classic SPL Token
              Program and the newer one, Token-2022, which many newer
              tokens use. Closing works the same way on both, but some
              older tools only read the classic program, which makes
              Token-2022 accounts invisible to them. If a cleanup tool
              reports fewer accounts than you expected, that is the first
              thing to check. This site scans both programs and labels
              which one each account is on.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Delegated accounts
            </h2>
            <p>
              A token account can carry a delegate: another address
              allowed to move that token up to an approved amount. An
              empty delegated account is still closable, but the delegate
              is cleared first, so the close cannot be used to sneak a
              permission past you. In practice that means a revoke
              instruction runs before the close, in the same transaction.
              The full explanation of approvals, including how to check
              for them on accounts you are keeping, is in{" "}
              <Link
                href="/guides/token-approvals"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                how to check and revoke Solana token approvals
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">Wrapped SOL</h2>
            <p>
              Wrapped SOL (wSOL) accounts are token accounts whose token is
              SOL itself. They cannot be closed while they hold SOL:
              the wrap has to be unwrapped first, which returns the SOL
              to your wallet, and then the empty account closes like any
              other. This site unwraps and closes in one step and charges
              nothing for it, because the SOL being returned is your own
              principal rather than rent the tool unlocked.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Batching and practical limits
            </h2>
            <p>
              A Solana transaction has a size limit, so large cleanups are
              split across several transactions, each needing its own
              approval. This site caps a run at 100 accounts, which means
              at most five approval popups, and tells you when more
              accounts remain so you can run it again. Every approval
              shows exactly which accounts it closes. If you would rather
              see the whole picture before acting, the read-only{" "}
              <Link
                href="/report"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                wallet health report
              </Link>{" "}
              lists everything the scan found, with no actions on the
              page.
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
              . The wallet route and the CLI route cost only the network
              fee; the choice between them and a tool is yours.
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
            </Link>{" "}
            ·{" "}
            <Link
              href="/guides/rent-reduction"
              className="underline underline-offset-2 hover:text-zinc-200"
            >
              The 2026 rent cuts
            </Link>{" "}
            ·{" "}
            <Link
              href="/guides/token-approvals"
              className="underline underline-offset-2 hover:text-zinc-200"
            >
              How to check and revoke Solana token approvals
            </Link>
          </p>
        </footer>
      </div>
      <JsonLd data={schema} />
    </main>
  );
}
