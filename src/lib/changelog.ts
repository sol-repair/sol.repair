/**
 * The product changelog: dated, plain-voice notes on what shipped.
 *
 * The page renders this list in array order, newest first, and one
 * entry here is exactly one visible item there. Adding an entry is a
 * hand edit: put it at the top of the array with an ISO date and plain
 * language. The tests in tests/changelog.test.tsx pin the shape, the
 * newest-first order, and the project writing rules, so a hand edit
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
    date: "2026-11-11",
    title: "A failed excess-lamport scan now says so",
    body:
      "When the excess-lamport check cannot be read from the network, " +
      "the section now shows an honest failed state with a scan-again " +
      "button, instead of disappearing as if no account held excess " +
      "lamports.",
  },
  {
    date: "2026-11-11",
    title:
      "A retry now only happens when the account still matches your review",
    body:
      "When a transaction expires without landing, the burn, unwrap, " +
      "withdraw, and revoke flows offer one retry. That retry now " +
      "happens only when a fresh read shows the account exactly as it " +
      "was when you reviewed it. If the balance or lamports moved, the " +
      "tool stops, shows the current figures, and asks for a fresh " +
      "review instead of re-asking your wallet. The review cards for " +
      "those same flows also stop if the account changed between your " +
      "review and your approval click. Your wallet still approves every " +
      "transaction, and the transactions themselves are built exactly " +
      "as before.",
  },
  {
    date: "2026-11-11",
    title: "The pages now say what a failed transaction costs",
    body:
      "A failed transaction still costs the network fee, and the pages " +
      "say so now. The explainer states the exact fee a failed " +
      "transaction charged and shows its attempted instructions labeled " +
      "as attempted and rolled back, instead of hiding them. The action " +
      "cards, the repair card, and the what-did-i-just-sign guide say " +
      "the same thing in their own words: the effects were rolled back, " +
      "and the network fee was still charged. The fee ledger's running " +
      "total is labeled as covering the fees shown while more pages " +
      "remain, the weekly recovered figure is labeled as mainnet, and " +
      "the read-only pages now refuse to fetch when a deployment is " +
      "configured for a network they cannot serve. Token-2022 mints " +
      "that carry a permanent delegate show it beside the mint and " +
      "freeze authorities, with a note that it is a mint-level " +
      "authority the account owner cannot revoke. The privacy policy " +
      "was refreshed to describe the explainer and the read-only " +
      "transaction listing, and the terms and the transaction-size " +
      "guide gained two honest qualifiers.",
  },
  {
    date: "2026-11-10",
    title: "The interface is changing, the transaction format is not",
    body:
      "This note is for the two groups that depend on how a repair is " +
      "built: developers running their own clients from the published " +
      "transaction format, and people finishing a repair in the browser. " +
      "The interface has changed: on November 3 large repairs gained a " +
      "one-click continue after a finished run, and a single pass that " +
      "repairs everything a scan finds has now shipped. One confirmation " +
      "covers closing the empty accounts and burning the dust balances, " +
      "every transaction still asks for its own wallet approval, and " +
      "the separate repair and burn actions stay where they were. The " +
      "transaction format has not changed and is not part of that work. " +
      "The instructions and their order are the " +
      "same, each transaction still closes at most 20 accounts, the " +
      "service fee is still 1% of the SOL the closes return, floored to " +
      "whole lamports and sent as one transfer riding at the end of each " +
      "transaction to the same fee wallet, and the rules that decide " +
      "which accounts can be closed are the same. The guide to the repair " +
      "transaction remains accurate as published, and any future change " +
      "to the format is announced here before it ships.",
  },
  {
    date: "2026-11-03",
    title: "Large repairs can continue with one click",
    body:
      "After a repair finishes, the wallet is scanned again, as before. " +
      "When that fresh scan still finds more than one run's worth of " +
      "closable accounts, the page now offers a continue button: one " +
      "click re-selects what the scan found and starts the next repair, " +
      "wallet approvals included. Wallets at or under the 100-account " +
      "run cap see no change at all. The transactions themselves are " +
      "unchanged: still 20 closes per transaction, with the 1% service " +
      "fee transfer riding at the end of each batch, exactly as the " +
      "developer guide describes.",
  },
  {
    date: "2026-11-01",
    title: "The recovered-to-date counter refreshes for the week",
    body:
      "The counter now reads 1.334663483 SOL across 43 wallets and 721 " +
      "closed accounts, as of November 1, 2026. Every row behind the " +
      "number is chain-verifiable on the fee ledger, and the next " +
      "scheduled update is November 8, 2026.",
  },
  {
    date: "2026-10-31",
    title: "A correction pass on the guides, the terms, and the disclosure lines",
    body:
      "A full read of every page found two stale claims: the approvals guide " +
      "named Revoke.cash as a Solana revoking tool when its own site does not " +
      "list Solana, and the random-tokens guide still quoted the September " +
      "rent minimum from before the second cut. Both are corrected. The terms " +
      "now describe the burn-and-close action and its fee. The report page " +
      "and the homepage now say the scan also reads the public mint accounts " +
      "behind held tokens. Several smaller wording fixes ride along.",
  },
  {
    date: "2026-10-31",
    title: "The scan rows are redesigned with labeled fields and authority facts",
    body:
      "Every row now labels what each address is: the Account (the token " +
      "account itself) and the Mint (the token), so the two can no longer " +
      "be confused. Rows holding tokens also show who controls the token: " +
      "whether the mint authority is active or revoked, and whether a " +
      "freeze authority exists, with a link to the controlling address. " +
      "Frozen accounts lead with Frozen. and state plainly that only the " +
      "token’s freeze authority can unfreeze them, or that nothing can " +
      "when that authority was given up. The amount each empty account " +
      "recovers is emphasized, the example scan before connecting matches " +
      "the real scan, and the scrolled lists use a slim dark scrollbar.",
  },
  {
    date: "2026-10-31",
    title: "The report shows who can mint and who can freeze each token",
    body:
      "The scan now reads each token's mint account and shows whether " +
      "the mint authority is active or revoked, and whether a freeze " +
      "authority exists, on the mint lines under the authority lists. " +
      "Frozen accounts state it plainly: only the token's freeze " +
      "authority can unfreeze them, with the authority linked where the " +
      "chain named one. These facts are read from the chain itself, the " +
      "same way the rest of the scan reads, and nothing about which " +
      "accounts can be closed changed.",
  },
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
