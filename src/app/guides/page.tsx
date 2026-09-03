import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Guides | SOL.repair",
  description:
    "Plain-English guides to Solana token accounts: why random tokens appear, what rent is, and how closing an empty account works.",
  alternates: { canonical: "/guides" },
};

const GUIDES = [
  {
    href: "/guides/random-tokens",
    title: "Why do I have random tokens in my wallet?",
    summary:
      "Spam airdrops explained, the one rule that keeps you safe, and what those accounts actually cost you.",
  },
  {
    href: "/guides/solana-rent",
    title: "What is Solana rent?",
    summary:
      "Rent is a deposit, not a fee. Real numbers, a simple calculator, and where the number comes from.",
  },
  {
    href: "/guides/close-token-accounts",
    title: "How to close empty token accounts",
    summary:
      "Exactly what the closeAccount instruction does, and how to check any tool before you sign.",
  },
];

export default function GuidesIndexPage() {
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
          Guides
        </h1>
        <p className="mb-8 text-sm leading-relaxed text-zinc-300">
          Short, honest explanations of the things this tool deals with. No
          hype, and nothing you cannot verify yourself.
        </p>

        <div className="divide-y divide-zinc-800 border-y border-zinc-800">
          {GUIDES.map((guide) => (
            <Link
              key={guide.href}
              href={guide.href}
              className="block py-4 transition-colors hover:bg-zinc-900/40"
            >
              <h2 className="text-sm font-medium text-zinc-100">
                {guide.title}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-zinc-500">
                {guide.summary}
              </p>
            </Link>
          ))}
        </div>

        <footer className="mt-12 border-t border-zinc-900 pt-6 text-xs leading-relaxed text-zinc-400">
          <Link
            href="/"
            className="underline underline-offset-2 hover:text-zinc-200"
          >
            Run the scan
          </Link>
        </footer>
      </div>
    </main>
  );
}
