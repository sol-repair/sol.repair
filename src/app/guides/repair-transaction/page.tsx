import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/pageMetadata";
import { guideSchema } from "@/lib/guideSchema";
import { GuideBreadcrumb, JsonLd } from "@/components/GuideBreadcrumb";
import { SiteHeader } from "@/components/SiteHeader";
import { GuideToc } from "@/components/GuideToc";
import {
  estimateNetworkFee,
  MAX_CLOSE_INSTRUCTIONS_PER_TX,
} from "@/lib/solana/transactions";
import { FEE_PERCENT, feeAmountLamports } from "@/lib/solana/fees";
import { WITHDRAW_EXCESS_LAMPORTS_TAG } from "@/lib/solana/excessLamports";
import { TOKEN_ACCOUNT_RENT_LAMPORTS_CURRENT } from "@/lib/rent";
import type { ClosableAccount } from "@/lib/solana/tokenAccounts";

export const metadata: Metadata = pageMetadata({
  title: "The transaction the repair tool builds",
  description:
    "Every instruction the repair tool puts on the wire: the shapes, the order, the batching cap, and the fee, documented for developers running their own clients.",
  path: "/guides/repair-transaction",
});

const schema = guideSchema({
  title: "The transaction the repair tool builds",
  description: metadata.description as string,
  path: "/guides/repair-transaction",
  datePublished: "2026-10-28",
  dateModified: "2026-10-28",
});

// The numbers below are not typed by hand. They are computed from the
// same shipped constants the tool uses, so this page cannot drift from
// the code, and tests pin that.
const fmt = (value: bigint | number): string =>
  Number(value).toLocaleString("en-US");

const exampleAccount: ClosableAccount = {
  pubkey: "example",
  mint: "example",
  lamports: TOKEN_ACCOUNT_RENT_LAMPORTS_CURRENT,
  program: "spl",
};
const exampleFee = feeAmountLamports([exampleAccount]);
const fullBatch: ClosableAccount[] = Array.from(
  { length: MAX_CLOSE_INSTRUCTIONS_PER_TX },
  () => exampleAccount
);
const fullBatchRent = fullBatch.reduce(
  (sum, account) => sum + BigInt(account.lamports),
  0n
);
const fullBatchFee = feeAmountLamports(fullBatch);
const batchingAnchor = `why-batches-stop-at-${MAX_CLOSE_INSTRUCTIONS_PER_TX}`;

export default function RepairTransactionGuide() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <SiteHeader active="guides" />

        <GuideBreadcrumb title="The transaction the repair tool builds" />

        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-50">
          The transaction the repair tool builds
        </h1>

        <GuideToc
          items={[
            { href: "#who-this-page-is-for", label: "Who this page is for" },
            { href: "#what-the-tool-will-close", label: "What the tool will close" },
            { href: "#the-instructions-in-order", label: "The instructions, in order" },
            { href: `#${batchingAnchor}`, label: `Why batches stop at ${MAX_CLOSE_INSTRUCTIONS_PER_TX}` },
            { href: "#the-service-fee", label: "The service fee" },
            { href: "#clearing-a-delegate-without-closing", label: "Clearing a delegate without closing" },
            { href: "#wrapped-sol-the-unwrap", label: "Wrapped SOL: the unwrap" },
            { href: "#dust-tokens-burn-then-close", label: "Dust tokens: burn, then close" },
            { href: "#token-2022-extensions-that-block-a-close", label: "Token-2022 extensions that block a close" },
            { href: "#excess-lamports-on-token-2022", label: "Excess lamports on Token-2022" },
            { href: "#check-it-yourself", label: "Check it yourself" },
          ]}
        />

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <h2 id="who-this-page-is-for" className="mb-2 text-lg font-semibold text-zinc-50">
              Who this page is for
            </h2>
            <p>
              People run their own repair clients against the same chain this
              site uses, and until now the only reference for what the tool
              sends was its compiled bundle. This page is the reference
              instead. It documents every instruction the tool builds: the
              shape of each one, the order they go in, how transactions are
              batched, and how the fee is computed.
            </p>
            <p className="mt-2">
              Everything here is public by construction. The instructions are
              ordinary program instructions, your wallet shows them to you
              before you approve anything, and the numbers on this page are
              rendered from the same constants the shipped tool uses, so the
              page and the code cannot drift apart. If this format ever
              changes, the change is announced in the site&apos;s{" "}
              <Link
                href="/changelog"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                changelog
              </Link>{" "}
              first.
            </p>
          </section>

          <section>
            <h2 id="what-the-tool-will-close" className="mb-2 text-lg font-semibold text-zinc-50">
              What the tool will close
            </h2>
            <p>
              The scan reads every token account your wallet owns, on both
              token programs, and sorts them into two lists: eligible, and
              skipped with a reason. The eligible list is the accounts the
              chain will let you close so the rent comes back to you.
            </p>
            <p className="mt-2">
              The eligibility rules, in the order the scan applies them. The
              token balance must be zero, which is the one rule the chain
              itself enforces. The account must be initialized. The close
              authority must be your own wallet, because only that authority
              can sign a close. The account must not be a wrapped-SOL
              account, which the unwrap action handles instead. A frozen
              account still closes as long as it is empty, and an account
              with an active delegate stays eligible and gets a Revoke
              first, covered below.
            </p>
            <p className="mt-2">
              The extra checks exist so the tool never offers to break a
              setup you built on purpose. Every skip is reported with its
              reason, never hidden, so you can check the scan&apos;s work
              yourself. Token-2022 accounts that pass everything above get
              one more read, on their extensions, with its own section
              below.
            </p>
          </section>

          <section>
            <h2 id="the-instructions-in-order" className="mb-2 text-lg font-semibold text-zinc-50">
              The instructions, in order
            </h2>
            <p>
              A repair transaction is built like this. Each eligible account
              contributes one CloseAccount instruction, in the order the
              scan listed them. An account flagged with an active delegate
              contributes one Revoke instruction immediately before its own
              CloseAccount. The service fee transfer, when there is one, is
              appended after all of the closes, which makes it the last
              instruction of the transaction.
            </p>
            <p className="mt-2">
              CloseAccount is instruction 9 on both token programs. It
              carries three keys: the token account to close, writable; the
              destination for the returned rent, writable; and the signing
              authority. The destination is always your own wallet. The
              builder takes no other destination, so no other address can
              appear there. One byte of instruction data: the number 9.
            </p>
            <p className="mt-2">
              Revoke is instruction 5 on both token programs. It carries two
              keys: the token account, writable, and your wallet as the only
              signer. One byte of data: 5. The chain refuses a Revoke on a
              frozen account, so a frozen delegated account is closed
              without one. Closing the account ends the delegation with it,
              because there is nothing left for a delegate to spend from.
            </p>
            <p className="mt-2">
              That is the whole transaction. The tool adds nothing else: no
              approvals, no transfers beyond the fee, no compute budget
              settings of its own. If you want to read a finished
              transaction instruction by instruction, the{" "}
              <Link
                href="/understand"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                explainer
              </Link>{" "}
              decodes any signature you paste.
            </p>
          </section>

          <section>
            <h2 id={batchingAnchor} className="mb-2 text-lg font-semibold text-zinc-50">
              Why batches stop at {MAX_CLOSE_INSTRUCTIONS_PER_TX}
            </h2>
            <p>
              A Solana transaction is limited to 1,232 bytes. A compiled
              CloseAccount costs about 39 bytes, so about 28 of them fit in
              one transaction. The tool caps batches at{" "}
              {MAX_CLOSE_INSTRUCTIONS_PER_TX} and leaves the remaining room
              for the wallet, which may append instructions of its own when
              it signs.
            </p>
            <p className="mt-2">
              A wallet with more eligible accounts than the cap gets more
              than one transaction. The batches keep the scan&apos;s order,
              each transaction is approved separately, and each carries its
              own fee transfer for the closes inside it.
            </p>
          </section>

          <section>
            <h2 id="the-service-fee" className="mb-2 text-lg font-semibold text-zinc-50">
              The service fee
            </h2>
            <p>
              Each transaction in a repair carries a service fee of{" "}
              {FEE_PERCENT} percent of the rent the closes in that same
              transaction return, floored to whole lamports. It rides as a
              plain system transfer from your wallet to the site&apos;s fee
              address, after the closes, so the rent they just returned
              covers it. A wallet with no SOL beyond the recovered rent can
              still pay it.
            </p>
            <p className="mt-2">
              With the current figures: an empty token account created after
              the 2026 rent cuts holds {fmt(TOKEN_ACCOUNT_RENT_LAMPORTS_CURRENT)}{" "}
              lamports of{" "}
              <Link
                href="/guides/solana-rent"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                rent
              </Link>
              . Closing one returns all of it, and {FEE_PERCENT} percent,
              floored, is {fmt(exampleFee)} lamports. A full batch of{" "}
              {MAX_CLOSE_INSTRUCTIONS_PER_TX} returns {fmt(fullBatchRent)}{" "}
              lamports and pays {fmt(fullBatchFee)}. The network&apos;s own
              base fee is separate: {fmt(estimateNetworkFee())} lamports per
              signature, per transaction, paid whether the transaction
              succeeds or fails.
            </p>
            <p className="mt-2">
              The fee is not enforced by any program. Nothing on chain
              requires a custom client to pay it. The tool charges it
              because keeping the tool running has a cost, and the rule is
              stated here in full rather than left in a bundle: if you run
              your own client, whether to include the same transfer is your
              decision.
            </p>
            <p className="mt-2">
              Every charge the tool collects is public. The{" "}
              <Link
                href="/fees"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                fee ledger
              </Link>{" "}
              reads the fee wallet&apos;s history straight from the chain,
              so anyone can check every payment without trusting this page.
              One edge rule: the tool skips the fee while the fee address
              does not exist on chain yet, because the network rejects a
              transfer that would leave an account below the rent minimum.
              The repair itself never depends on the fee.
            </p>
          </section>

          <section>
            <h2 id="clearing-a-delegate-without-closing" className="mb-2 text-lg font-semibold text-zinc-50">
              Clearing a delegate without closing
            </h2>
            <p>
              A funded account with an active delegate does not have to be
              closed to clear the permission. The revoke action sends
              exactly one instruction, the Revoke from above, against the
              program that owns the account. Nothing is closed, no tokens
              move, and there is no service fee. For what a delegate can
              and cannot do, see{" "}
              <Link
                href="/guides/token-approvals"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                the token approvals guide
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 id="wrapped-sol-the-unwrap" className="mb-2 text-lg font-semibold text-zinc-50">
              Wrapped SOL: the unwrap
            </h2>
            <p>
              A wrapped-SOL account is a token account whose balance is SOL.
              Unwrapping it closes the account, and CloseAccount moves every
              lamport it holds back to your wallet: the wrapped balance and
              the rent deposit together. The shape is the same instruction 9
              as in the repair, with the destination hardwired to your
              wallet. If the account carries a delegate, the Revoke comes
              first, the same pair the repair builds.
            </p>
            <p className="mt-2">
              There is no service fee on an unwrap. The only cost is the
              network&apos;s base fee.
            </p>
          </section>

          <section>
            <h2 id="dust-tokens-burn-then-close" className="mb-2 text-lg font-semibold text-zinc-50">
              Dust tokens: burn, then close
            </h2>
            <p>
              A funded account holding a token you do not want can be
              emptied and closed in one transaction: a Burn instruction
              followed by CloseAccount. Burning permanently destroys the
              token balance, so the tool asks before it burns and names the
              exact amount. The Burn names three keys: the token account,
              the mint, and your wallet as the signer, with the amount in
              the instruction data. The amount is the balance read from the
              chain when the action runs, not the one from the scan. The
              close is the same instruction 9 as everywhere else.
            </p>
            <p className="mt-2">
              This action does carry the service fee: {FEE_PERCENT} percent
              of the lamports the account holds, transferred after the
              close, same rule as the repair.
            </p>
          </section>

          <section>
            <h2 id="token-2022-extensions-that-block-a-close" className="mb-2 text-lg font-semibold text-zinc-50">
              Token-2022 extensions that block a close
            </h2>
            <p>
              Token-2022 accounts can carry extensions, and a parsed scan
              cannot see them. So every Token-2022 account that passed the
              eligibility checks gets one raw read of its extension list
              before it is offered. Two classes of extension block a close:
              a withheld transfer fee that only the mint&apos;s fee
              authority can release, and an encrypted balance in a privacy
              extension. An account carrying either moves to the skipped
              list with the reason named, because one blocked account would
              fail its whole transaction: a transaction lands completely or
              not at all.
            </p>
            <p className="mt-2">
              Extensions outside those classes never block a close.
              ImmutableOwner, which every associated token account is
              created with, blocks changing the account&apos;s owner, not
              closing it. Classic-program accounts cannot carry extensions
              and are never read.
            </p>
          </section>

          <section>
            <h2 id="excess-lamports-on-token-2022" className="mb-2 text-lg font-semibold text-zinc-50">
              Excess lamports on Token-2022
            </h2>
            <p>
              When the rent rates stepped down, accounts kept the lamports
              they were created with, and some Token-2022 accounts now hold
              more than the current rent-exempt reserve for their size. The
              excess-withdrawal action sends one hand-built instruction,
              WithdrawExcessLamports, instruction {WITHDRAW_EXCESS_LAMPORTS_TAG}{" "}
              on the Token-2022 program. It carries three keys: the token
              account, writable; your wallet as the destination, writable;
              and your wallet as the signing authority. The instruction data
              is the single tag byte, {WITHDRAW_EXCESS_LAMPORTS_TAG}. There
              is no amount field: the program drains everything above the
              current reserve and leaves the account open holding exactly
              the reserve.
            </p>
            <p className="mt-2">
              The instruction never checks whether the account is frozen,
              and it refuses wrapped-SOL accounts. The classic Token Program
              has no such instruction, which is why this action is
              Token-2022 only. There is no service fee: nothing closes, and
              the withdrawn lamports are your own principal.
            </p>
          </section>

          <section>
            <h2 id="check-it-yourself" className="mb-2 text-lg font-semibold text-zinc-50">
              Check it yourself
            </h2>
            <p>
              Every claim on this page is checkable without trusting it.
              Paste any transaction signature into the explainer and read
              the instruction list against the shapes above. Open the fee
              ledger and match its rows against the fee wallet&apos;s
              history on any explorer. The rent figures come from the
              chain&apos;s own rent calculation, and the constants this page
              renders from ship with the tool.
            </p>
            <p className="mt-2">
              If you build your own client and something here disagrees with
              what you observe on chain, the chain is right, and the
              changelog is where any format change will be announced.
            </p>
          </section>
        </div>
      </div>
      <JsonLd data={schema} />
    </main>
  );
}
