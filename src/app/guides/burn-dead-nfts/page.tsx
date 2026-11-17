import type { Metadata } from "next";
import Link from "next/link";
import { pageMetadata } from "@/lib/pageMetadata";
import { guideSchema } from "@/lib/guideSchema";
import { GuideBreadcrumb, JsonLd } from "@/components/GuideBreadcrumb";
import { SiteHeader } from "@/components/SiteHeader";
import { GuideToc } from "@/components/GuideToc";

export const metadata: Metadata = pageMetadata({
  title: "How to burn a dead NFT and recover its SOL",
  description:
    "A dead NFT still parks rent in its token, metadata, and edition accounts. What a plain burn strands forever, which burns the network refuses, and the one that returns all three deposits.",
  path: "/guides/burn-dead-nfts",
});

const schema = guideSchema({
  title: "How to burn a dead NFT and recover its SOL",
  description: metadata.description as string,
  path: "/guides/burn-dead-nfts",
  datePublished: "2026-11-17",
  dateModified: "2026-11-17",
});

export default function BurnDeadNftsGuide() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <SiteHeader active="guides" />

        <GuideBreadcrumb title="How to burn a dead NFT and recover its SOL" />

        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-50">
          How to burn a dead NFT and recover its SOL
        </h1>

        <GuideToc
          items={[
            { href: "#what-a-dead-nft-is", label: "What a dead NFT is" },
            { href: "#the-rent-inside-one", label: "The rent inside one" },
            { href: "#why-a-plain-burn-strands-it", label: "Why a plain burn strands the rent" },
            { href: "#what-cannot-be-recovered", label: "What cannot be recovered" },
            { href: "#burning-one-properly", label: "Burning one properly" },
            { href: "#what-you-are-shown", label: "What you are shown before you sign" },
            { href: "#the-fee", label: "The fee" },
            { href: "#checking-before-you-sign", label: "Checking before you sign" },
          ]}
        />

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <p>
              An NFT you cannot sell, from a project that is long gone, still
              parks SOL on the chain. Its token account, its metadata account,
              and its master edition account each hold a rent deposit, and
              they sit there whether you look at them or not. This page
              explains what a dead NFT is, why burning it the ordinary way
              strands most of that money forever, and the one instruction
              that returns all three deposits together. Nothing here needs
              your seed phrase, on this site or any honest one.
            </p>
          </section>

          <section>
            <h2 id="what-a-dead-nft-is" className="mb-2 text-lg font-semibold text-zinc-50">What a dead NFT is</h2>
            <p>
              On Solana an NFT is not one thing. It is a small set of
              accounts: the token account in your wallet, the mint, a
              metadata account holding the name and the link to the picture,
              and, for a one-of-one NFT, a master edition account. When a
              collection dies, the trading stops, but none of those accounts
              deletes itself. What is left is a one-of-one token nobody
              wants, and the accounts behind it are all that remains of the
              project. That is what this site means by a dead NFT.
            </p>
          </section>

          <section>
            <h2 id="the-rent-inside-one" className="mb-2 text-lg font-semibold text-zinc-50">The rent inside one</h2>
            <p>
              Every one of those accounts holds its rent deposit, and the
              deposits are bigger than most people expect. A typical
              one-of-one NFT from before the 2026 rent cuts holds:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>the token account: 2,039,280 lamports, about 0.00204 SOL</li>
              <li>the metadata account: 3,733,800 lamports, about 0.00373 SOL</li>
              <li>the master edition account: 1,030,080 lamports, about 0.00103 SOL</li>
            </ul>
            <p className="mt-2">
              Together that is 6,803,160 lamports, about 0.0068 SOL, more
              than three times what a plain empty token account holds. NFTs
              minted after the rent cuts hold somewhat less; NFTs with long
              picture links hold more in their metadata. The{" "}
              <Link
                href="/guides/solana-rent"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                rent guide
              </Link>{" "}
              explains where these numbers come from.
            </p>
          </section>

          <section>
            <h2 id="why-a-plain-burn-strands-it" className="mb-2 text-lg font-semibold text-zinc-50">Why a plain burn strands the rent</h2>
            <p>
              A token burn destroys tokens. What happens around it decides
              where the money goes. The token programs have a burn
              instruction and a close instruction, and they reach the token
              account only. The spl-token command line tool follows the same
              shape: it can burn the token and close the token account, and
              it has no command that reaches an NFT&rsquo;s metadata or
              edition accounts at all. Those are separate accounts owned by
              the metadata program, and no token-program instruction closes
              them.
            </p>
            <p className="mt-2">
              So after a plain burn, the metadata and master edition
              accounts are still there, still holding their deposits. And
              here is the part worth knowing: they are now unreachable by
              anyone, forever. The metadata program closes them only inside
              its own burn flow, and that flow requires the live token, so
              it has to happen in the same breath as the burn, not after
              it. The program does carry an ownerless close, but it requires
              a fixed Metaplex-controlled authority to sign, and it sends
              the rent to a fixed Metaplex destination, not to you.
              Stranded means stranded.
            </p>
          </section>

          <section>
            <h2 id="what-cannot-be-recovered" className="mb-2 text-lg font-semibold text-zinc-50">What cannot be recovered</h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Already burned the plain way. If the token is gone, the
                deposits behind it are gone with it. No tool can recover
                them; anyone who tells you otherwise is selling something.
              </li>
              <li>
                Prints outstanding. A master edition with print editions
                still outstanding cannot be burned; the network refuses
                until none remain.
              </li>
              <li>
                Frozen. A frozen token account cannot be burned. Only the
                mint&rsquo;s freeze authority can unfreeze it.
              </li>
              <li>
                Token-2022 NFTs. The burn used here covers classic-program
                NFTs; a Token-2022 NFT needs a different instruction this
                site does not send yet.
              </li>
              <li>
                No edition account. An NFT minted without an edition has no
                edition deposit to return, and the burn does not apply to
                it.
              </li>
            </ul>
          </section>

          <section>
            <h2 id="burning-one-properly" className="mb-2 text-lg font-semibold text-zinc-50">Burning one properly</h2>
            <p>
              This site&rsquo;s scan lists the dead NFTs it finds and offers
              the three-account burn for each eligible one. Nothing is
              selected by default, and each NFT is its own transaction and
              its own approval. Right before anything is signed, the page
              re-reads every account fresh and refuses if anything changed:
              a token that disappeared, an account that turned frozen, an
              edition that gained prints, and you see why with nothing
              signed.
            </p>
            <p className="mt-2">
              The transaction carries exactly one instruction, Metaplex&rsquo;s
              BurnNft. It burns the single token permanently and then closes
              the token account, the metadata account, and the master
              edition account, so all three deposits return to your wallet
              together. If the NFT belongs to a verified collection, the
              burn also reduces that collection&rsquo;s on-chain size by
              one. Burning is permanent; this site cannot judge what an NFT
              is worth, so make sure you want it gone before you approve.
            </p>
          </section>

          <section>
            <h2 id="what-you-are-shown" className="mb-2 text-lg font-semibold text-zinc-50">What you are shown before you sign</h2>
            <p>
              The approval card shows the NFT&rsquo;s name, collection, and
              mint, plus the exact figures: what the closes return and the
              fee. One honest detail about older NFTs: some metadata
              accounts carry more lamports than they need today, left over
              from earlier rent rates or stored creation fees. The
              network&rsquo;s close for a metadata account returns today&rsquo;s
              rent-exempt minimum and leaves that excess behind in a tiny
              husk account; the token and edition accounts return
              everything they hold. The card promises the return figure, not
              the deposit figure, so what you are shown is what you get.
            </p>
          </section>

          <section>
            <h2 id="the-fee" className="mb-2 text-lg font-semibold text-zinc-50">The fee</h2>
            <p>
              One percent of the SOL the three closes return, floored to
              whole lamports, as a plain transfer inside the same
              transaction. It is visible before you approve and charged only
              if the transaction succeeds. Burning the token itself is
              charged nothing. Every fee ever collected is public in the{" "}
              <Link
                href="/fees"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                fee ledger
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 id="checking-before-you-sign" className="mb-2 text-lg font-semibold text-zinc-50">Checking before you sign</h2>
            <p>
              You can read what any transaction did before or after signing
              it: paste the signature into the{" "}
              <Link
                href="/understand"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                transaction explainer
              </Link>
              . The exact byte-level shape of the burn is documented in{" "}
              <Link
                href="/guides/repair-transaction"
                className="underline underline-offset-2 hover:text-zinc-100"
              >
                the transaction the repair tool builds
              </Link>
              , and the basics of closing accounts, including the routes
              that do not involve this site, are in{" "}
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
