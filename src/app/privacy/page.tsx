import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { pageMetadata } from "@/lib/pageMetadata";

export const metadata: Metadata = pageMetadata({
  title: "Privacy Policy",
  description:
    "Privacy policy for SOL.repair: no accounts, no tracking cookies, scanning happens in your browser.",
  path: "/privacy",
});

export default function PrivacyPage() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <SiteHeader />

        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-50">
          Privacy Policy
        </h1>
        <p className="mb-8 text-sm text-zinc-400">
          Last updated: November 11, 2026
        </p>

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <h2 className="mb-2 text-lg font-semibold text-zinc-50">
              The short version
            </h2>
            <p>
              There are no accounts, no sign-ups, no email forms, and no
              passwords. We do not ask for, receive, or store your private
              keys or seed phrase, ever. There is no backend: the site runs
              entirely in your browser, and nothing you do here is stored on
              our side. The things you provide are your wallet&rsquo;s public
              address when you connect, and any transaction signature you
              paste into the explainer. Beyond the standard technical request
              data any website&rsquo;s host sees (request time, IP address,
              browser type), nothing identifying is collected, and a public
              key is just a public blockchain address.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-zinc-50">
              1. What the site reads
            </h2>
            <p>
              All scanning and transaction-building happens in your browser.
              Every read below is a standard request to a Solana RPC provider
              (the node network that serves public blockchain data), and every
              address in it is a public blockchain object.
            </p>
            <p className="mt-2">When you connect your wallet and scan:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-400">
              <li>
                Your token accounts on both Solana token programs (SPL Token
                and Token-2022), so the tool can list what you hold and what
                can be closed.
              </li>
              <li>
                The public mint accounts behind the tokens you hold, including
                who can mint more of a token and who can freeze its accounts.
                These are public objects, read by mint address.
              </li>
              <li>
                Public account details behind the actions: delegation state,
                wrapped-SOL state, Token-2022 extension data, and current rent
                minimums.
              </li>
              <li>
                For NFTs you hold, the public metadata account behind the
                token and, when it names a verified collection, the public
                metadata account of that collection, so a burn card can show
                the token&rsquo;s name and the collection&rsquo;s name. Those
                names are self-declared on-chain text. No images are fetched:
                the NFT cards show text only.
              </li>
            </ul>
            <p className="mt-2">On the read-only pages:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-400">
              <li>
                /understand reads the public transaction behind a signature you
                paste. If you connect a wallet there, it also lists your
                wallet&rsquo;s newest public transactions so you can pick one to
                explain. That connection is read-only: the page can never build
                or sign anything.
              </li>
              <li>
                /fees reads the public transaction history of the site&rsquo;s
                fee wallet and rebuilds the ledger in your browser. It reads the
                fee wallet, not your wallet.
              </li>
            </ul>
            <p className="mt-2">While an action is running:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-400">
              <li>
                The current blockhash and the status of transactions this site
                submitted, so the result you see is verified against the chain
                rather than assumed.
              </li>
              <li>
                A pre-sign simulation, only when you choose to run it: the
                public details of the transactions the site builds (account
                addresses and rent destinations) are sent to the network&rsquo;s
                simulation endpoint before anything is signed.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-zinc-50">
              2. What the site sends
            </h2>
            <p>
              Only your public key (in read requests), public blockchain
              addresses, and any transaction your wallet has already signed. The
              five actions the site can propose, closing empty token accounts,
              revoking a delegation, unwrapping wrapped SOL, burning a dust
              balance so its account can close, and withdrawing excess lamports,
              are all built in your browser, shown to you in full, and signed by
              you in your own wallet. The site never signs anything and cannot.
              Signed transaction data goes from your browser to the Solana
              network, not to us.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-zinc-50">
              3. Third parties we rely on
            </h2>
            <p>
              We do not sell, rent, or share data. There is nothing to sell.
              Two categories of third party are inherently involved:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-400">
              <li>
                Solana RPC providers, which receive your public key and public
                blockchain addresses in read requests and standard technical
                request data (such as IP address) like any website request.
              </li>
              <li>
                Vercel, which hosts this website and keeps standard server
                logs (request time, IP address, user agent) for security and
                abuse prevention.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-zinc-50">
              4. Cookies and local storage
            </h2>
            <p>
              We set no advertising or tracking cookies. Your browser stores
              your wallet preference (for example, &ldquo;Phantom&rdquo;) in
              local storage so the connect button remembers your last choice.
              That stays on your device and is never sent anywhere.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-zinc-50">
              5. Analytics
            </h2>
            <p>
              We use Vercel Web Analytics to count visits and page views in
              aggregate. It operates without cookies and without cross-site
              tracking, and does not collect names, email addresses, wallet
              addresses, or any personal identifiers. We cannot and do not
              build profiles of individual visitors. If we ever add a
              different analytics provider, this page will say so.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-zinc-50">
              6. What we never do
            </h2>
            <ul className="list-disc space-y-1 pl-5 text-zinc-400">
              <li>Never ask for your seed phrase or private keys.</li>
              <li>Never require an account, email, or any sign-up.</li>
              <li>Never sell or share data with advertisers or data brokers.</li>
              <li>Never send a transaction you did not approve in your wallet.</li>
              <li>
                Never contact any service other than the Solana RPC endpoints
                described above and the analytics described in section 5. There
                are no third-party registries, enrichment APIs, or trackers in
                the code.
              </li>
              <li>
                Never collect transaction history beyond what your browser
                displays during your visit.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-zinc-50">
              7. Changes to this policy
            </h2>
            <p>
              If our data practices ever change in a way that matters, we will
              update this page and its &ldquo;last updated&rdquo; date.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-zinc-50">Contact</h2>
            <p>
              Privacy questions:{" "}
              <a
                href="mailto:admin@sol.repair"
                className="text-emerald-400 underline underline-offset-2"
              >
                admin@sol.repair
              </a>
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
