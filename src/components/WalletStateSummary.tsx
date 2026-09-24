/**
 * Wallet state inspection summary (G.1). Presentation only: renders an
 * already-computed WalletInspectionSummary from the read-only scan. No
 * wallet adapter, no RPC, no scanning, and no repair logic live here — the
 * finding lines describe observable state, and the only action surface
 * remains the existing repair controls beneath the scan panel.
 */

import type { FindingKind, WalletInspectionSummary } from "@/lib/solana/walletInspection";
import { lamportsToSol } from "@/lib/solana/tokenAccounts";

const plural = (count: number, singular: string, pluralForm: string) =>
  count === 1 ? singular : pluralForm;

export function WalletStateSummary({
  summary,
}: {
  summary: WalletInspectionSummary;
}) {
  const { totals, rentLamports, incomplete } = summary;
  const count = (kind: FindingKind) => totals.byKind[kind];

  if (totals.accounts === 0) {
    return (
      <div
        data-testid="wallet-state-summary"
        className="mt-3 rounded-md border border-zinc-800 bg-black/40 p-3 text-xs leading-relaxed text-zinc-400"
      >
        <p className="text-zinc-300">No token accounts were found.</p>
        <p className="mt-2">
          Checked: token accounts owned by this wallet in both token programs
          (SPL Token and Token-2022), as of the network&rsquo;s finalized view
          at scan time.
        </p>
        <p className="mt-1">
          Not checked: your SOL balance, stake accounts, accounts owned by
          other programs, and transaction history (the Understand page reads
          transactions).
        </p>
        <p className="mt-1">
          This means no token accounts existed for this wallet in that view.
          It does not describe anything else about the wallet.
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="wallet-state-summary"
      className="mt-3 rounded-md border border-zinc-800 bg-black/40 p-3 text-xs leading-relaxed text-zinc-400"
    >
      <p className="text-zinc-300">
        Inspected {totals.accounts} token{" "}
        {plural(totals.accounts, "account", "accounts")} (SPL Token and
        Token-2022), finalized view.
      </p>
      <ul className="mt-2 space-y-1">
        {count("empty-closable") > 0 && (
          <li>
            {count("empty-closable")} empty{" "}
            {plural(count("empty-closable"), "account", "accounts")},{" "}
            ~{lamportsToSol(rentLamports.recoverable)} SOL of rent recoverable.
            The repair controls below close these.
          </li>
        )}
        {count("funded-holding") > 0 && (
          <li>
            {count("funded-holding")}{" "}
            {plural(
              count("funded-holding"),
              "account holds",
              "accounts hold"
            )}{" "}
            tokens. SOL.REPAIR does not close accounts holding tokens and does
            not judge what the tokens are worth.
          </li>
        )}
        {count("active-delegation") > 0 && (
          <li>
            {count("active-delegation")} standing{" "}
            {plural(count("active-delegation"), "delegation", "delegations")}.
            An address can spend from these accounts until the delegation is
            revoked. SOL.REPAIR cannot tell why a delegation exists.
          </li>
        )}
        {count("foreign-close-authority") > 0 && (
          <li>
            {count("foreign-close-authority")}{" "}
            {plural(
              count("foreign-close-authority"),
              "account names",
              "accounts name"
            )}{" "}
            a close authority other than this wallet. Only that authority can
            close them.
          </li>
        )}
        {count("wrapped-sol") > 0 && (
          <li>
            {count("wrapped-sol")} wrapped-SOL{" "}
            {plural(count("wrapped-sol"), "account", "accounts")}.
          </li>
        )}
        {count("frozen") > 0 && (
          <li>
            {count("frozen")} frozen{" "}
            {plural(count("frozen"), "account", "accounts")}. Only the
            token&rsquo;s freeze authority can unfreeze them.
          </li>
        )}
        {count("uninitialized") > 0 && (
          <li>
            {count("uninitialized")}{" "}
            {plural(
              count("uninitialized"),
              "account is",
              "accounts are"
            )}{" "}
            not initialized. They cannot be closed.
          </li>
        )}
        {count("unreadable") > 0 && (
          <li>
            {count("unreadable")}{" "}
            {plural(count("unreadable"), "account could", "accounts could")}{" "}
            not be read.{" "}
            {plural(count("unreadable"), "It is", "They are")} shown in the
            skipped list below.
          </li>
        )}
      </ul>
      {incomplete && (
        <p className="mt-2">
          Some entries could not be fully read, so this summary is incomplete.
        </p>
      )}
      <p className="mt-2">
        Checked: token accounts owned by this wallet in both token programs,
        finalized view. Not checked: your SOL balance, stake accounts, accounts
        owned by other programs, and transaction history (the Understand page
        reads transactions).
      </p>
    </div>
  );
}
