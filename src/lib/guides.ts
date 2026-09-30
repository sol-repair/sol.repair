/** Single source for the published guides. The home-page section and the
 *  guides index both render this list, so do not add a second copy anywhere;
 *  the owner's writing rules are enforced on these strings by tests.
 */
export type Guide = {
  href: string;
  title: string;
  summary: string;
};

export const GUIDES: Guide[] = [
  {
    href: "/guides/close-token-accounts",
    title: "How to close empty token accounts",
    summary:
      "Every route back to your rent: wallet built-ins, the CLI, and web tools, plus the special cases.",
  },
  {
    href: "/guides/solana-rent",
    title: "What is Solana rent?",
    summary:
      "Why every token account parks a small SOL deposit, and what happens when it closes.",
  },
  {
    href: "/guides/rent-reduction",
    title: "Solana's rent cuts and the SOL above the new minimum",
    summary:
      "The 2026 rate cuts, why older accounts now hold excess SOL, and the two ways it comes back.",
  },
  {
    href: "/guides/token-approvals",
    title: "How to check and revoke Solana token approvals",
    summary:
      "What a delegate can and cannot do, how to find yours, and how to clear it.",
  },
  {
    href: "/guides/random-tokens",
    title: "Why do I have random tokens in my wallet?",
    summary:
      "Where dust tokens come from and why they show up in your wallet.",
  },
  {
    href: "/guides/what-did-i-just-sign",
    title: "What did I just sign?",
    summary:
      "How to read a transaction: the steps it runs, and the permissions it can leave behind.",
  },
];
