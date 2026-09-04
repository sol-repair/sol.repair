import Link from "next/link";

// The home-page blurbs are the owner's approved home-page wording. The
// guides index carries its own summaries, so these two lists must not be
// merged.
const GUIDES = [
  {
    href: "/guides/random-tokens",
    title: "Why do I have random tokens in my wallet?",
    description:
      "Where dust tokens come from and why they show up in your wallet.",
  },
  {
    href: "/guides/solana-rent",
    title: "What is Solana rent?",
    description:
      "Why every token account parks a small SOL deposit, and what happens when it closes.",
  },
  {
    href: "/guides/close-token-accounts",
    title: "How do I close an empty token account?",
    description:
      "The steps and the checklist, whether you use this tool or any other.",
  },
];

export default function GuidesSection() {
  return (
    <section className="mt-12 border-t border-zinc-900 pt-6">
      <h2 className="text-sm font-semibold text-zinc-200">Guides</h2>
      <div className="mt-3 space-y-3">
        {GUIDES.map((guide) => (
          <div key={guide.href}>
            <Link
              href={guide.href}
              className="text-sm text-zinc-300 underline underline-offset-2 hover:text-white"
            >
              {guide.title}
            </Link>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              {guide.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
