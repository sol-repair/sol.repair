import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service | SOL.repair",
  description:
    "Terms of service for SOL.repair: non-custodial use, the 1% success fee, network fees, and liability.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
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
          Terms of Service
        </h1>
            <p className="mb-8 text-sm text-zinc-500">Last updated: August 15, 2026</p>

        <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              1. What this service is
            </h2>
            <p>
              SOL.repair is a browser-based tool that helps you find
              empty Solana token accounts and build the transactions that close
              them, returning the rent deposited in those accounts to your
              wallet. It is software that assists you in acting on your own
              blockchain account. It is not a wallet, exchange, custodian, or
              financial service.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              2. Non-custodial; we never touch your keys
            </h2>
            <p>
              We never receive, store, or transmit your private keys or seed
              phrase. Every transaction is built in your browser and signed by
              you, in your own wallet, on your own device. We cannot move your
              funds, and we cannot reverse, modify, or recover any transaction
              you approve. Nothing happens without your explicit approval in
              your wallet.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              3. You are responsible for what you approve
            </h2>
            <p>
              Before approving any transaction, review what it does. Your
              wallet displays the full contents of each transaction. By
              approving a transaction, you accept responsibility for its
              effects. The tool only proposes the closing of token accounts
              that hold zero tokens, but blockchain software can contain bugs
              and networks can behave unexpectedly; verify before you sign.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              4. Fees
            </h2>
            <p>
              SOL.repair charges a service fee equal to 1% of the SOL that a
              successful repair returns to your wallet. The fee is
              success-based: if your repair recovers nothing, you owe no
              service fee. The service fee is included in the repair
              transaction you approve, as a transfer to our fee address, and
              your wallet displays the complete cost (service fee and
              network fee) before you sign. Our fee address is published in
              the open-source repository, so anyone can verify where the
              service fee goes. Standard Solana network fees also apply and
              are paid to the Solana network, not to us: a base fee of
              about 0.000005 SOL per transaction, plus any priority fee
              your wallet adds when you approve (most wallets add a small
              one by default).
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              5. No financial advice
            </h2>
            <p>
              Nothing on this site is financial, investment, tax, or legal
              advice. Closing token accounts is a mechanical blockchain
              operation, not a recommendation about any token, asset, or
              strategy.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              6. Software provided &ldquo;as is&rdquo;
            </h2>
            <p>
              The service is provided on an &ldquo;as is&rdquo; and
              &ldquo;as available&rdquo; basis, without warranties of any
              kind, express or implied, including merchantability, fitness for
              a particular purpose, and non-infringement. We do not warrant
              that the service will be uninterrupted, timely, secure, or
              error-free, or that blockchain networks will process your
              transactions.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              7. Limitation of liability
            </h2>
            <p>
              To the maximum extent permitted by applicable law, SOL.repair
              and its operator shall not be liable for any indirect,
              incidental, special, consequential, or punitive damages, or any
              loss of profits, tokens, data, or funds, arising from or related
              to your use of the service. Our aggregate liability for any
              claim shall not exceed the total service fees you paid us in
              the twelve months preceding the claim.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              8. Intellectual property
            </h2>
            <p>
              The name, design, and content of this website are the property
              of its operator. &ldquo;Solana&rdquo; and related marks belong
              to their respective owners (see section 9). This section does
              not limit any rights you have under open-source licenses that
              may apply to software we publish.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              9. No affiliation
            </h2>
            <p>
              SOL.repair is an independent project. It is not affiliated with,
              endorsed by, or sponsored by the Solana Foundation, Anza, or the
              developers of any wallet software (Phantom, Solflare, Backpack,
              Ledger, or others). Wallet and blockchain names are used only to
              describe compatibility.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">
              10. Changes to these terms
            </h2>
            <p>
              We may update these terms from time to time. The version
              displayed on this page is the version in effect. Material
              changes will be reflected in the &ldquo;last updated&rdquo;
              date above.
            </p>
          </section>

          <section>
            <h2 className="mb-2 font-medium text-zinc-100">Contact</h2>
            <p>
              Questions about these terms:{" "}
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
