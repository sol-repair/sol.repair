/** Single source for the published guides. The home-page section and the
 *  guides index both render this list, so do not add a second copy anywhere;
 *  the owner's writing rules are enforced on these strings by tests. */
export type Guide = {
  href: string;
  title: string;
  summary: string;
};

export const GUIDES: Guide[] = [
  {
    href: "/guides/random-tokens",
    title: "Why do I have random tokens in my wallet?",
    summary:
      "Where dust tokens come from and why they show up in your wallet.",
  },
  {
    href: "/guides/solana-rent",
    title: "What is Solana rent?",
    summary:
      "Why every token account parks a small SOL deposit, and what happens when it closes.",
  },
  {
    href: "/guides/close-token-accounts",
    title: "How to close empty token accounts",
    summary:
      "The steps and the checklist, whether you use this tool or any other.",
  },
];
