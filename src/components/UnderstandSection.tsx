import Link from "next/link";

/**
 * Homepage section pointing at the transaction explainer. Same pattern
 * as the Guides section: a short honest summary and a link. The copy
 * mirrors the promises the explainer page itself makes (read-only,
 * never asks for an approval), pinned by the homepage link tests.
 */
export default function UnderstandSection() {
  return (
    <section className="mt-12 border-t border-zinc-900 pt-6">
      <h2 className="text-sm font-semibold text-zinc-200">
        Understand a transaction
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        Paste any transaction signature, or connect a wallet to list its
        recent ones, and see what the transaction did and what it left
        behind, in plain language. Read-only: it never connects a wallet
        for signing and never asks for an approval.
      </p>
      <Link
        href="/understand"
        className="mt-3 inline-block rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-900"
      >
        Open the explainer
      </Link>
    </section>
  );
}
