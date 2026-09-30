import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/pageMetadata";
import { guideSchema } from "@/lib/guideSchema";
import { GuideBreadcrumb, JsonLd } from "@/components/GuideBreadcrumb";

export const metadata: Metadata = pageMetadata({
  title: "Solana rent cuts: how to reclaim your excess SOL",
  description:
    "Solana lowered its rent rate in steps in 2026, so accounts funded at the old minimum now hold excess SOL. What changed, what it means, and the two honest ways to get yours back.",
  path: "/guides/rent-reduction",
});

const schema = guideSchema({
  title: "Solana's rent cuts and the SOL above the new minimum",
  description: metadata.description as string,
  path: "/guides/rent-reduction",
  datePublished: "2026-09-30",
  dateModified: "2026-09-30",
});

export default function RentReductionGuide() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center justify-between">
          <span className="font-mono text-sm text-zinc-400">SOL.repair</span>
          <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-300">
            ← Back
          </Link>
        </div>

        <GuideBreadcrumb title="Solana's rent cuts and the SOL above the new minimum" />

        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-50">
          Solana&apos;s rent cuts and the SOL above the new minimum
        </h1>

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <p>
              A Solana token account is not free to store. When it is
              created, it must hold a deposit, called the rent-exempt
              minimum, that stays locked for as long as the account exists.
              Close the account and the deposit comes back. If the deposit
              idea is new to you, read{" "}
              <Link
                href="/guides/solana-rent"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                what is Solana rent
              </Link>{" "}
              first; this page is about what changed in 2026 and how it can
              pay you back.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              What changed in 2026
            </h2>
            <p>
              Solana is cutting the rent rate in five steps. The change is
              proposal SIMD-0437, Incrementally Reduce lamports_per_byte to
              696, and each step is switched on by its own feature gate:
              there is no fixed calendar, and the network only proceeds to
              the next step after its own risk review. The rate started at
              6,960 lamports per byte and steps down through 6,333, 5,080,
              2,575, 1,322, to a final 696.
            </p>
            <p className="mt-2">
              Two steps are live as this page is written. The first went
              live on mainnet on September 4, 2026. The second followed
              within days; this site re-read the resulting minimum straight
              from the chain on September 14, 2026. Three steps remain
              scheduled by the proposal but not yet switched on.
            </p>
          </section>

          <section>
            <h2 className="mb-3 font-medium text-zinc-100">
              What that means for a token account
            </h2>
            <p className="mb-3">
              The deposit equals 128 bytes of fixed overhead plus the
              account&apos;s data size, times the rate. A standard token
              account holds 165 bytes of data, so 293 bytes in total. That
              makes the arithmetic easy to check: 293 times the rate.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-left text-zinc-400">
                    <th className="py-2 pr-4 font-normal">Rate</th>
                    <th className="py-2 pr-4 font-normal">
                      Standard account deposit
                    </th>
                    <th className="py-2 font-normal">Status</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-300">
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-4">6,960</td>
                    <td className="py-2 pr-4">
                      2,039,280 lamports (0.00203928 SOL)
                    </td>
                    <td className="py-2">
                      Old minimum, before September 4, 2026
                    </td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-4">6,333</td>
                    <td className="py-2 pr-4">1,855,569 lamports</td>
                    <td className="py-2">Step 1, live September 4, 2026</td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-4">5,080</td>
                    <td className="py-2 pr-4">
                      1,488,440 lamports (0.00148844 SOL)
                    </td>
                    <td className="py-2">
                      Step 2, current (chain-verified September 14, 2026)
                    </td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-4">2,575</td>
                    <td className="py-2 pr-4">would be 754,475 lamports</td>
                    <td className="py-2">Step 3, not yet switched on</td>
                  </tr>
                  <tr className="border-b border-zinc-900">
                    <td className="py-2 pr-4">1,322</td>
                    <td className="py-2 pr-4">would be 387,346 lamports</td>
                    <td className="py-2">Step 4, not yet switched on</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">696</td>
                    <td className="py-2 pr-4">would be 203,928 lamports</td>
                    <td className="py-2">Step 5, not yet switched on</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3">
              The would-be figures are arithmetic from the proposal&apos;s
              own formula, not promises: each step needs its feature gate,
              and the network can pause between steps.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Why older accounts now hold excess SOL
            </h2>
            <p>
              Your deposit was set when the account was created, at that
              moment&apos;s rate. The rate has since fallen, but the
              account still holds what it was funded with. The difference
              between what the account holds and today&apos;s lower minimum
              is called excess lamports. It is not a fee and not new money:
              it is your own SOL, sitting above a line that moved. A token
              account created before September 4, 2026 holds about 0.00055
              SOL more than the network now requires. When the next steps
              land, the same accounts will hold more again.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Two ways to get it back
            </h2>
            <p>
              Close the account. If the account is empty, closing returns
              the entire balance, deposit and excess together, in the same
              transaction. This works for both token programs, the classic
              SPL Token Program and Token-2022. The steps are in{" "}
              <Link
                href="/guides/close-token-accounts"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                how to close empty token accounts
              </Link>
              .
            </p>
            <p className="mt-2">
              Withdraw just the excess, and keep the account. If you still
              use the account, you do not have to lose it. The Token-2022
              program has an instruction for exactly this,
              WithdrawExcessLamports: it moves every lamport above the
              current minimum to your wallet and leaves the account open
              with exactly its new deposit. The classic Token Program has
              no such instruction. For accounts on the classic program,
              the excess is only reachable by closing the account, which
              requires an empty one.
            </p>
            <p className="mt-2">
              That program distinction matters, and most explanations blur
              it. It is the difference between reclaiming something and
              being told a feature exists that your account cannot use.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              What this site supports today
            </h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Closing empty accounts on both token programs, with the
                revoke and unwrap cases handled in the same repair.
              </li>
              <li>
                Withdrawing excess lamports from Token-2022 accounts,
                leaving the account open. No fee on this one: the lamports
                are your own principal and nothing closes.
              </li>
              <li>
                Wrapped-SOL accounts are handled by the unwrap flow rather
                than excess withdrawal, because the program rejects native
                accounts for that instruction.
              </li>
              <li>
                On closes, the fee is 1 percent of the recovered rent, only
                when the recovery succeeds, and every fee ever collected is
                on the public{" "}
                <Link
                  href="/fees"
                  className="underline underline-offset-2 hover:text-zinc-100"
                >
                  fee ledger
                </Link>
                .
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              The scan finds both paths
            </h2>
            <p>
              Connect your wallet and the scan lists closable empty
              accounts and Token-2022 accounts holding excess, each with
              its own number, and you choose what runs. Read-only first is
              also fine: the{" "}
              <Link
                href="/report"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                wallet health report
              </Link>{" "}
              shows the same picture without any action.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              Watch for claim sites
            </h2>
            <p>
              Anything advertising a rent payout you can claim should be
              read slowly. There is no airdrop here: the only SOL involved
              is your own deposit, and getting it back is a transaction you
              sign in your own wallet. A legitimate flow shows you the
              exact instruction before you approve it. No honest tool asks
              for your seed phrase, ever.
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
      <JsonLd data={schema} />
    </main>
  );
}
