/**
 * The product changelog: dated, plain-voice notes on what shipped.
 *
 * The page renders this list in array order, newest first, and one
 * entry here is exactly one visible item there. Adding an entry is a
 * hand edit: put it at the top of the array with an ISO date and plain
 * language. The tests in tests/changelog.test.tsx pin the shape, the
 * newest-first order, and the owner's writing rules, so a hand edit
 * that drifts fails loudly.
 */

export interface ChangelogEntry {
  /** ISO date (YYYY-MM-DD) the work shipped. Rendered as-is. */
  date: string;
  title: string;
  body: string;
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    date: "2026-10-16",
    title: "Close authority addresses named in the health report",
    body:
      "Accounts that name a close authority other than you are grouped by " +
      "that authority in the summary, with each address linked and a count " +
      "of the accounts it can close.",
  },
  {
    date: "2026-10-16",
    title: "Token-2022 accounts that cannot be closed now state the cause",
    body:
      "Accounts whose extensions block a close, such as a withheld transfer " +
      "fee or an encrypted balance, are skipped with the cause named, " +
      "instead of being offered and failing on chain.",
  },
  {
    date: "2026-10-16",
    title: "Dust burns are refused before signing when the mint blocks them",
    body:
      "If a mint's extensions block a burn, the burn card refuses with the " +
      "reason before any transaction is built.",
  },
  {
    date: "2026-10-16",
    title: "The fee wallet is re-checked at repair time",
    body:
      "The app re-checks its fee account when a repair is requested, not " +
      "only when the wallet connects.",
  },
  {
    date: "2026-10-16",
    title: "The explainer reads Token-2022 excess withdrawals",
    body:
      "The Understand page now decodes the instruction that moves SOL held " +
      "above a Token-2022 account's rent reserve to a destination address.",
  },
  {
    date: "2026-10-16",
    title: "The fee ledger describes the fee base precisely",
    body:
      "The ledger now describes the fee as 1% of the SOL a close returns, " +
      "not as a share of recovered rent.",
  },
  {
    date: "2026-10-16",
    title: "An honest 404 page",
    body:
      "Unknown routes now show the site's own not-found page: one link " +
      "home, and the fact that nothing was requested from your wallet.",
  },
  {
    date: "2026-10-16",
    title: "A redesign of the site chrome, type scale, and navigation",
    body:
      "Every page shares one header and one type scale. The homepage is " +
      "restructured with numbered sections, and guides gained an on-this-page " +
      "contents list.",
  },
];
