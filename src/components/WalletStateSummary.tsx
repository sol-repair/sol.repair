/**
 * Wallet state inspection summary (G.1). Presentation only: renders an
 * already-computed WalletInspectionSummary from the read-only scan. No
 * wallet adapter, no RPC, no scanning, and no repair logic live here — the
 * finding lines describe observable state, and the only action surface
 * remains the existing repair controls beneath the scan panel.
 */

import type { FindingKind, WalletInspectionSummary } from "@/lib/solana/walletInspection";
import { SOLANA_NETWORK } from "@/lib/solana/connection";
import {
  lamportsToSol,
  type ClosableAccount,
  type SkippedAccount,
} from "@/lib/solana/tokenAccounts";

const plural = (count: number, singular: string, pluralForm: string) =>
  count === 1 ? singular : pluralForm;

/** Explorer link for an account address (not a transaction), or null on
 *  localhost: a local validator exists only on the machine running it,
 *  so a Solscan link would always 404. */
function accountUrl(address: string): string | null {
  if (SOLANA_NETWORK === "mainnet-beta") {
    return `https://solscan.io/account/${address}`;
  }
  if (SOLANA_NETWORK === "devnet") {
    return `https://solscan.io/account/${address}?cluster=devnet`;
  }
  if (SOLANA_NETWORK === "testnet") {
    return `https://solscan.io/account/${address}?cluster=testnet`;
  }
  return null;
}

/** Short form for on-chain addresses in dense lists; the full address
 *  stays available in the title tooltip and via the explorer link. */
function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** An authority address as an explorer link, or the short form when the
 *  active network has no public explorer. Same classes and attrs as the
 *  homepage account links. */
function AccountLink({ address }: { address: string }) {
  const href = accountUrl(address);
  if (href === null) {
    return <span title={address}>{short(address)}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      onClick={(e) => e.stopPropagation()}
      className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
    >
      {short(address)}
    </a>
  );
}

/** One row of a grouped authority list: the authority address (undefined
 *  when entries carried no address) and how many accounts it covers. */
interface AuthorityGroup {
  address?: string;
  count: number;
}

/** Group a finding kind's entries by the close-authority address each
 *  entry recorded, one row per authority. Entries without an address
 *  (reachable only from hand-built or stale summaries; the scan records
 *  it at every skip site) bucket under undefined. Rows sort by count
 *  descending, then address ascending, so the display is deterministic;
 *  the ordering is a stable display choice, not a ranking. */
function groupByCloseAuthority(
  entries: ReadonlyArray<ClosableAccount | SkippedAccount>
): AuthorityGroup[] {
  const counts = new Map<string, number>();
  let unrecorded = 0;
  for (const entry of entries) {
    // Only a SkippedAccount carries a cause, so the union narrows there.
    const authority = "cause" in entry ? entry.closeAuthority : undefined;
    if (authority === undefined) {
      unrecorded += 1;
    } else {
      counts.set(authority, (counts.get(authority) ?? 0) + 1);
    }
  }
  const groups: AuthorityGroup[] = [...counts.entries()].map(
    ([address, count]) => ({ address, count })
  );
  groups.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    const left = a.address ?? "";
    const right = b.address ?? "";
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (unrecorded > 0) groups.push({ address: undefined, count: unrecorded });
  return groups;
}

export function WalletStateSummary({
  summary,
}: {
  summary: WalletInspectionSummary;
}) {
  const { totals, rentLamports, groups, incomplete } = summary;
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
            a close authority other than this wallet.{" "}
            {plural(
              count("foreign-close-authority"),
              "Only that authority can close it.",
              "Only the authority each account names can close it."
            )}
            <details className="mt-1">
              <summary className="cursor-pointer py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                Who holds those authorities
              </summary>
              <div className="mt-2 max-h-72 space-y-1 overflow-auto font-mono text-[11px] leading-relaxed text-zinc-400">
                {groupByCloseAuthority(groups["foreign-close-authority"]).map(
                  (group) =>
                    group.address === undefined ? (
                      // No address on the entries: reachable only from a
                      // hand-built or stale summary, never from the scan.
                      <div key="unrecorded" className="break-all">
                        authority not recorded on {group.count} of these
                        accounts.
                      </div>
                    ) : (
                      <div key={group.address} className="break-all">
                        <AccountLink address={group.address} /> can close{" "}
                        {group.count} of these accounts.
                      </div>
                    )
                )}
              </div>
            </details>
          </li>
        )}
        {count("funded-foreign-close-authority") > 0 && (
          <li>
            {count("funded-foreign-close-authority")} funded{" "}
            {plural(
              count("funded-foreign-close-authority"),
              "account names",
              "accounts name"
            )}{" "}
            a close authority other than this wallet.{" "}
            {plural(
              count("funded-foreign-close-authority"),
              "It is",
              "They are"
            )}{" "}
            counted above with the accounts holding tokens.
            <details className="mt-1">
              <summary className="cursor-pointer py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                Who holds the authorities on the funded accounts
              </summary>
              <div className="mt-2 max-h-72 space-y-1 overflow-auto font-mono text-[11px] leading-relaxed text-zinc-400">
                {groupByCloseAuthority(
                  groups["funded-foreign-close-authority"]
                ).map((group) =>
                  group.address === undefined ? (
                    // No address on the entries: reachable only from a
                    // hand-built or stale summary, never from the scan.
                    <div key="unrecorded" className="break-all">
                      authority not recorded on {group.count} of these
                      accounts.
                    </div>
                  ) : (
                    <div key={group.address} className="break-all">
                      <AccountLink address={group.address} /> is the close
                      authority on {group.count} funded{" "}
                      {plural(group.count, "account", "accounts")}.
                    </div>
                  )
                )}
              </div>
            </details>
          </li>
        )}
        {count("wrapped-sol") > 0 && (
          <li>
            {count("wrapped-sol")} empty wrapped-SOL{" "}
            {plural(count("wrapped-sol"), "account", "accounts")}. Funded
            wrapped-SOL accounts are counted under accounts holding tokens.
          </li>
        )}
        {count("frozen") > 0 && (
          <li>
            {count("frozen")} frozen{" "}
            {plural(count("frozen"), "account", "accounts")}. Only the
            token&rsquo;s freeze authority can unfreeze them. An empty
            frozen account can still be closed.
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
