import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Why do I have random tokens in my wallet? | SOL.repair",
  description:
    "Random tokens show up in Solana wallets through airdrop marketing and spam. Why they appear, what they actually cost you, and how to clean them up.",
  alternates: { canonical: "/guides/random-tokens" },
};

export default function RandomTokensGuide() {
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
          Why do I have random tokens in my wallet?
        </h1>

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              It is normal, and usually harmless
            </h2>
            <p>
              You open your wallet and there are tokens you never bought. Maybe
              several. Names you do not recognize, and balances of 1, or 5, or
              0. Almost always, nobody has compromised your wallet. On Solana,
              anyone can create a token and send it to any address. Sending it
              costs the sender a fraction of a cent. That is the whole trick.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Why people send them
            </h2>
            <p>
              Most random tokens are advertising. Someone minted millions of
              tokens for almost nothing and sent them to thousands of wallets,
              hoping a few people will search the name, find their site, and
              buy. Some are pure junk. A few exist to bait you onto a fake
              site.
            </p>
            <p className="mt-2">
              One rule keeps you safe here. Never search a token&apos;s name
              and connect your wallet to the first site you find. A token
              sitting in your wallet cannot take anything from you. A site you
              connect to and approve can.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              What they actually cost you
            </h2>
            <p>
              The tokens are not the cost. The account holding them is. Every
              token account on Solana must keep a deposit of rent to stay
              open. For a standard token account, that deposit is about 0.002
              SOL. Accounts created before September 4, 2026 hold 2,039,280
              lamports, and newer ones hold 1,855,569 lamports. It sits there
              for as long as the
              account exists. It does not drain away. It is your SOL, held in
              an account you never asked for.
            </p>
            <p className="mt-2">
              If you have ten of these accounts, about 0.02 SOL of yours is
              locked. Twenty, about 0.04. It adds up.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">How to clean it up</h2>
            <p>
              Accounts with a zero balance can be closed. Closing one returns
              its rent deposit to your wallet in the same transaction. That is
              what this site does. Connect your wallet, the scan lists every
              token account you own with its rent, and you choose what to
              close. You sign every transaction. Nothing moves without you.
            </p>
            <p className="mt-2">
              Accounts that still hold a token balance are skipped and kept
              safe. The steps are in{" "}
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
              href="/guides/solana-rent"
              className="underline underline-offset-2 hover:text-zinc-200"
            >
              What is Solana rent?
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
