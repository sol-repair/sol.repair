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
    date: "2026-10-28",
    title: "A developer guide to the repair transaction",
    body:
      "A new guide documents the exact instructions the tool builds: the " +
      "shape of each instruction, the order they go in, the batching cap, " +
      "and how the fee is computed, plus the revoke, unwrap, burn, and " +
      "excess-withdrawal actions. It is written for developers running " +
      "their own repair clients. The numbers in it render from the same " +
      "constants the tool ships with, and any future change to the format " +
      "gets announced here first.",
  },
  {
    date: "2026-10-25",
    title: "The homepage counts what the tool has recovered",
    body:
      "A weekly line now tracks the total rent returned to users through " +
      "repairs and burn-closes since launch. It states its as-of date and " +
      "the next scheduled update, and it is refreshed by hand every Sunday " +
      "from the same chain data the fee ledger shows. Unwraps are not " +
      "counted: they never charge a fee.",
  },
  {
    date: "2026-10-25",
    title: "A waiting card now explains a missed wallet approval",
    body:
      "When an action has been waiting on a wallet approval for about 15 " +
      "seconds, its card now adds one sentence: no approval has come " +
      "through and the transaction has not been sent. If no approval " +
      "window is open, the sentence says to reload the page and try " +
      "again. The wait itself is unchanged, and the sentence disappears " +
      "as soon as the wallet answers.",
  },
  {
    date: "2026-10-25",
    title: "Brave on iPhone now gets a connect error that says why",
    body:
      "When connecting fails in Brave on iPhone, the error now says this " +
      "browser cannot connect a wallet, and points to the browser built " +
      "into the Phantom or Solflare app as the way to continue. Every " +
      "other browser keeps the same message as before.",
  },
  {
    date: "2026-10-22",
    title: "The fee ledger says when history could not be read",
    body:
      "When the RPC returns no data for a transaction in the fee " +
      "wallet's history, the ledger now says so instead of leaving it " +
      "out silently. A note above the list counts what could not be " +
      "read and says the list can be incomplete. No fee row changed, " +
      "and today's mainnet history reads complete, so nothing changes " +
      "for you yet.",
  },
  {
    date: "2026-10-22",
    title: "The page now loads before the wallet code does",
    body:
      "The wallet-connect code no longer loads with the page. You now get " +
      "the headline, the walkthrough, and the whole pre-connect page " +
      "first, and the connect controls arrive a moment later. On a phone " +
      "this makes the first view noticeably lighter. Nothing about the " +
      "connect, scan, or repair flow changed.",
  },
  {
    date: "2026-10-18",
    title: "Wording tightened on undecodable transactions and lookalike authorities",
    body:
      "The Understand page no longer tells visitors that a transaction it " +
      "could not decode changed nothing. It now says the transaction could " +
      "not be explained, that the page only reads transactions and never " +
      "submits one, and that the transaction's effects cannot be determined " +
      "from this data. The health report's label for a lookalike close " +
      "authority now states what the address shows: a long System " +
      "Program-like prefix, and that it is not the system program. No " +
      "verdict about intent is made.",
  },
  {
    date: "2026-10-17",
    title: "The report says what each close authority is",
    body:
      "The report now says what each named close authority is, as far as " +
      "the chain can tell. The system program carries its own label, and " +
      "the fact that it cannot sign a token-account close. An address that " +
      "merely looks like the system program is called out as an imitation. " +
      "Token-2022 accounts show the token's name and symbol where the mint " +
      "carries them, and the summary separates rent you can still recover " +
      "from rent you cannot.",
  },
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
