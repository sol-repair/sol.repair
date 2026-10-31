/**
 * Wallet state inspection summary (G.1). Presentation only: renders an
 * already-computed WalletInspectionSummary from the read-only scan. No
 * wallet adapter, no RPC, no scanning, and no repair logic live here — the
 * finding lines describe observable state, and the only action surface
 * remains the existing repair controls beneath the scan panel.
 */

import type { FindingKind, WalletInspectionSummary } from "@/lib/solana/walletInspection";
import { authorityLabel } from "@/lib/solana/authorityNaming";
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
 *  when entries carried no address), how many accounts it covers, and
 *  the distinct mints behind those accounts that carried self-declared
 *  Token-2022 metadata and, where the mint decoded, the mint and freeze
 *  authority states. */
interface AuthorityGroup {
  address?: string;
  count: number;
  mints?: Array<{
    mint: string;
    name?: string;
    symbol?: string;
    mintAuthorityActive?: boolean;
    mintAuthority?: string;
    freezeAuthorityActive?: boolean;
    freezeAuthority?: string;
  }>;
}

/**
 * CAUTION on everything rendered from these groups: an authority label
 * is an observation about a string, and a mint's name and symbol are
 * SELF-DECLARED metadata read from the mint itself. Neither is verified
 * identity; both render as-is, with no trust or endorsement language.
 */
function groupByCloseAuthority(
  entries: ReadonlyArray<ClosableAccount | SkippedAccount>
): AuthorityGroup[] {
  const counts = new Map<string, number>();
  // Per authority: the distinct mints behind its accounts that carried
  // self-declared Token-2022 metadata, one row per mint, plus the mint
  // and freeze authority states where the mint decoded.
  const mintMeta = new Map<
    string,
    Map<
      string,
      {
        name?: string;
        symbol?: string;
        mintAuthorityActive?: boolean;
        mintAuthority?: string;
        freezeAuthorityActive?: boolean;
        freezeAuthority?: string;
      }
    >
  >();
  let unrecorded = 0;
  for (const entry of entries) {
    // Only a SkippedAccount carries a cause, so the union narrows there.
    const authority = "cause" in entry ? entry.closeAuthority : undefined;
    if (authority === undefined) {
      unrecorded += 1;
      continue;
    }
    counts.set(authority, (counts.get(authority) ?? 0) + 1);
    if (
      "cause" in entry &&
      (entry.mintName ||
        entry.mintSymbol ||
        entry.mintAuthorityActive !== undefined ||
        entry.freezeAuthorityActive !== undefined)
    ) {
      const perAuthority = mintMeta.get(authority) ?? new Map();
      perAuthority.set(entry.mint, {
        ...(entry.mintName ? { name: entry.mintName } : {}),
        ...(entry.mintSymbol ? { symbol: entry.mintSymbol } : {}),
        ...(entry.mintAuthorityActive !== undefined
          ? { mintAuthorityActive: entry.mintAuthorityActive }
          : {}),
        ...(entry.mintAuthority ? { mintAuthority: entry.mintAuthority } : {}),
        ...(entry.freezeAuthorityActive !== undefined
          ? { freezeAuthorityActive: entry.freezeAuthorityActive }
          : {}),
        ...(entry.freezeAuthority ? { freezeAuthority: entry.freezeAuthority } : {}),
      });
      mintMeta.set(authority, perAuthority);
    }
  }
  const groups: AuthorityGroup[] = [...counts.entries()].map(
    ([address, count]) => {
      const perAuthority = mintMeta.get(address);
      return {
        address,
        count,
        ...(perAuthority
          ? {
              mints: [...perAuthority.entries()]
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([mint, meta]) => ({ mint, ...meta })),
            }
          : {}),
      };
    }
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

/** The label for one authority row: registry lookup, then the imitation
 *  detector. An observation, never a verdict; undefined when nothing is
 *  known about the address. */
function labelFor(address: string): string | undefined {
  return authorityLabel(address) ?? undefined;
}

/** The self-declared mint lines under one authority row: name and
 *  symbol as plain text after the mint link, exactly as the mint
 *  declares them; then, where the scan decoded the mint, the mint
 *  authority and freeze authority states with the owner-approved copy
 *  and an authority link only when an authority exists. See the CAUTION
 *  above the grouping function: states are on-chain facts, the authority
 *  address is just an address, and neither judges anything. */
function MintLines({ group }: { group: AuthorityGroup }) {
  if (!group.mints || group.mints.length === 0) return null;
  return (
    <>
      {group.mints.map((entry) => (
        <div key={entry.mint} className="break-all">
          mint <AccountLink address={entry.mint} />{" "}
          {[entry.name, entry.symbol].filter(Boolean).join(" ")}
          {entry.mintAuthorityActive !== undefined && (
            <>
              {" · mint authority: "}
              {entry.mintAuthorityActive ? (
                <>
                  active <AccountLink address={entry.mintAuthority!} />
                </>
              ) : (
                "revoked"
              )}
            </>
          )}
          {entry.freezeAuthorityActive !== undefined && (
            <>
              {" · freeze authority: "}
              {entry.freezeAuthorityActive ? (
                <>
                  active <AccountLink address={entry.freezeAuthority!} />
                </>
              ) : (
                "none"
              )}
            </>
          )}
        </div>
      ))}
    </>
  );
}

/** The one honest answer to "what can be done about these" (spec
 *  verbatim), shared by both authority lists. */
function AuthorityGuidance() {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
        What can be done about these accounts
      </summary>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
        Only the close authority can sign a close. If it is not a wallet
        you control, the rent in these accounts cannot be recovered by
        you, and no tool can change that. Beware any service claiming to
        unlock these accounts.
      </p>
    </details>
  );
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
                        {labelFor(group.address) && (
                          <span> {labelFor(group.address)}</span>
                        )}
                        <MintLines group={group} />
                      </div>
                    )
                )}
              </div>
            </details>
            <AuthorityGuidance />
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
                      {labelFor(group.address) && (
                        <span> {labelFor(group.address)}</span>
                      )}
                      <MintLines group={group} />
                    </div>
                  )
                )}
              </div>
            </details>
            <AuthorityGuidance />
          </li>
        )}
        {count("wrapped-sol") > 0 && (
          <li>
            {count("wrapped-sol")} empty wrapped-SOL{" "}
            {plural(count("wrapped-sol"), "account", "accounts")}. Funded
            wrapped-SOL accounts are counted under accounts holding tokens.
          </li>
        )}
        {count("close-blocked-extension") > 0 && (
          <li>
            {count("close-blocked-extension")}{" "}
            {plural(
              count("close-blocked-extension"),
              "account holds",
              "accounts hold"
            )}{" "}
            a balance in a token extension the close would reject. The skip
            list names the blocker on each account.
            <details className="mt-1">
              <summary className="cursor-pointer py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                Which accounts carry those balances
              </summary>
              <div className="mt-2 max-h-72 space-y-1 overflow-auto font-mono text-[11px] leading-relaxed text-zinc-400">
                {groups["close-blocked-extension"].map((entry) => {
                  // Only SkippedAccount carries the blocker evidence, so
                  // the union narrows on the key.
                  const blocker =
                    "extensionBlocker" in entry
                      ? entry.extensionBlocker
                      : undefined;
                  return (
                    <div key={entry.pubkey} className="break-all">
                      <AccountLink address={entry.pubkey} />{" "}
                      {blocker === "withheld-fee"
                        ? "holds a withheld transfer fee."
                        : blocker === "confidential-balance"
                          ? "holds an encrypted balance."
                          : // No blocker on the entry: reachable only from
                            // a hand-built or stale summary, never from the
                            // scan.
                            "blocker not recorded."}
                    </div>
                  );
                })}
              </div>
            </details>
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
