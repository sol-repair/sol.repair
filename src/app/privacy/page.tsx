import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy | SOL.repair",
};

export default function PrivacyPage() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center justify-between">
          <span className="font-mono text-sm text-zinc-500">SOL.repair</span>
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
            ← Back
          </Link>
        </div>

        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-50">
          Privacy Policy
        </h1>
        <p className="mb-8 text-sm text-zinc-500">Last updated: August 14, 2026</p>

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              The short version
            </h2>
            <p>
              There are no accounts, no sign-ups, no email forms, and no
              passwords. We do not ask for, receive, or store your private
              keys or seed phrase, ever. The only thing you provide is
              your wallet&rsquo;s public address, which the app uses to look
              up which token accounts it owns on the public Solana
              blockchain. Beyond the standard technical request data any
              website&rsquo;s host sees (request time, IP address, browser
              type), nothing identifying is collected, and a public key is
              just a public blockchain address.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              1. What is processed, and where
            </h2>
            <p>
              All scanning and transaction-building happens in your browser.
              To look up your token accounts, the app sends your wallet&rsquo;s
              public address (and, when you run the optional pre-sign
              simulation, the public details of the transactions it builds:
              account addresses and rent destinations, all of which are
              public blockchain data) in standard requests to a Solana RPC
              provider (the node network that serves blockchain data).
              Transactions are signed by your wallet on your device. Signed
              transaction data goes from your browser to the Solana network,
              not to us.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              2. Third parties we rely on
            </h2>
            <p>
              We do not sell, rent, or share data. There is nothing to sell.
              Two categories of third party are inherently involved:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-400">
              <li>
                Solana RPC providers, which receive your public key in read
                requests and standard technical request data (such as IP
                address) like any website request.
              </li>
              <li>
                Vercel, which hosts this website and keeps standard server
                logs (request time, IP address, user agent) for security and
                abuse prevention.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              3. Cookies and local storage
            </h2>
            <p>
              We set no advertising or tracking cookies. Your browser stores
              your wallet preference (for example, &ldquo;Phantom&rdquo;) in
              local storage so the connect button remembers your last choice.
              That stays on your device and is never sent anywhere.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              4. Analytics
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
            <h2 className="mb-2 font-medium text-zinc-100">
              5. What we never do
            </h2>
            <ul className="list-disc space-y-1 pl-5 text-zinc-400">
              <li>Never ask for your seed phrase or private keys.</li>
              <li>Never require an account, email, or any sign-up.</li>
              <li>Never sell or share data with advertisers or data brokers.</li>
              <li>Never collect transaction history beyond what your browser
                displays during your visit.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              6. Changes to this policy
            </h2>
            <p>
              If our data practices ever change in a way that matters, we will
              update this page and its &ldquo;last updated&rdquo; date.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">Contact</h2>
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
