/**
 * Wallet scanning and account eligibility classification.
 *
 * This is the safety-critical core of SOL.repair. The eligibility checks
 * encoded here decide which accounts are safe to close and which ones need
 * their delegate revoked first. Getting this right is everything: if we
 * wrongly mark a funded account as closeable, a user could lose tokens.
 *
 * No React in this file. Pure logic, importable from tests without touching
 * the UI.
 */

import { Connection, PublicKey } from "@solana/web3.js";

/** The standard SPL Token Program. */
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

/** The Token-2022 Program (Token Extensions). Empty Token-2022 accounts
 *  also lock rent and are closable with the same instruction shape. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

/** Which token program owns an account, which determines which program must
 *  build the CloseAccount instruction. */
export type TokenProgram = "spl" | "token-2022";

const SCANNED_PROGRAMS: ReadonlyArray<{
  id: PublicKey;
  tag: TokenProgram;
}> = [
  { id: TOKEN_PROGRAM_ID, tag: "spl" },
  { id: TOKEN_2022_PROGRAM_ID, tag: "token-2022" },
];

/** Type shape of the parsed token account info returned by the RPC. */
interface TokenAccountInfo {
  mint: string;
  owner: string;
  tokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
  delegate: string | null;
  /** Omitted by the parsed RPC response when no close authority is set. */
  closeAuthority?: string | null;
  state: "initialized" | "uninitialized" | "frozen";
  isNative: boolean;
}

/** An account that passed all eligibility checks and can be safely closed. */
export interface ClosableAccount {
  /** The token account's public key, base58-encoded. Used as the account to
   *  close in the CloseAccount instruction. */
  pubkey: string;
  /** The mint this account is associated with. For display only. */
  mint: string;
  /** Lamports locked as rent. Returned to the owner when closed. */
  lamports: number;
  /** Owning token program. The CloseAccount instruction must target it. */
  program: TokenProgram;
  /** True when the account carries an active delegate. The close builder
   *  emits a Revoke instruction immediately before this account's
   *  CloseAccount. Absent on clean accounts. */
  needsRevoke?: boolean;
  /** True when the parsed account state is "frozen". Frozen EMPTY accounts
   *  are closable (that eligibility is unchanged); the flag exists so the
   *  inspection layer can show the frozen fact without re-deriving it. */
  frozen?: boolean;
}

/** Why an account was skipped, recorded at the exact site that chose the
 *  user-facing `reason` string so aggregation never has to match on prose.
 *  The `reason` string remains the only user-facing text. */
export type SkipCause =
  | "unreadable"
  | "funded"
  | "close-authority"
  | "wrapped-sol"
  | "uninitialized"
  | "frozen-with-delegate";

/** An account we skip on purpose, with the reason.
 *  Shown to the user so the scan is verifiable, not a black box. */
export interface SkippedAccount {
  pubkey: string;
  mint: string;
  /** Human-readable eligibility-check failure. */
  reason: string;
  program: TokenProgram;
  /** Machine-readable cause for aggregation; see SkipCause. */
  cause: SkipCause;
  /** Exact base-unit token balance. Evidence for the inspection summary;
   *  present only on funded skips (the only skips holding a nonzero
   *  balance) and only when the parsed response passed validation. */
  balance?: string;
  /** Token decimals, carried with `balance`. */
  decimals?: number;
  /** Rent (lamports) the account holds, carried with `balance`. */
  lamports?: number;
  /** True when the parsed response named an active delegate. Evidence
   *  only; the skip decision itself is unchanged. */
  delegated?: boolean;
  /** True when the parsed state is "frozen" (funded skips; frozen EMPTY
   *  accounts are eligible and carry the flag on ClosableAccount). */
  frozen?: boolean;
}

/** Result of scanning a wallet for closeable accounts. */
export interface ScanResult {
  /** Total SPL token accounts found, including non-eligible ones. */
  totalAccounts: number;
  /** Accounts that passed all five eligibility checks. */
  eligibleAccounts: ClosableAccount[];
  /** Total lamports recoverable by closing all eligible accounts. */
  recoverableLamports: bigint;
  /** Accounts found but not eligible, with the reason for each. */
  skippedAccounts: SkippedAccount[];
}

/**
 * Pull the parsed token info out of an RPC account entry, or null when the
 * provider returned something other than the parsed shape the scan requested
 * (base64 data, or a parsed field that is null, missing, or lacks info).
 * Null means "unreadable": report it, never guess at it.
 */
function readParsedInfo(data: unknown): TokenAccountInfo | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const parsed = (data as { parsed?: unknown }).parsed;
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const info = (parsed as { info?: unknown }).info;
  return typeof info === "object" && info !== null
    ? (info as TokenAccountInfo)
    : null;
}

/**
 * Scan a wallet for SPL token accounts and classify which are safe to close.
 *
 * Returns the full picture: total accounts found, which ones are eligible,
 * and how much SOL is locked in the eligible ones.
 *
 * Throws on RPC failure. The caller is responsible for error handling.
 */
export async function getClosableAccounts(
  connection: Connection,
  owner: PublicKey
): Promise<ScanResult> {
  // Scan BOTH token programs: classic SPL and Token-2022. Same eligibility
  // rules, same parsed-info shape, but each account must be closed by the
  // program that owns it.
  const eligibleAccounts: ClosableAccount[] = [];
  const skippedAccounts: SkippedAccount[] = [];
  let recoverableLamports = 0n;
  let totalAccounts = 0;

  for (const { id: programId, tag } of SCANNED_PROGRAMS) {
    const response = await connection.getParsedTokenAccountsByOwner(owner, {
      programId,
    });
    totalAccounts += response.value.length;

    for (const { pubkey, account } of response.value) {
      // The scan requests parsed encoding, but the response shape is
      // provider-supplied. An unreadable entry is reported as skipped
      // (never silently hidden, never classified without reading it)
      // instead of aborting the whole scan.
      const info = readParsedInfo(account.data);
      if (!info) {
        skippedAccounts.push({
          pubkey: pubkey.toString(),
          mint: "unknown",
          reason: "response could not be read (malformed RPC data)",
          program: tag,
          cause: "unreadable",
        });
        continue;
      }

      // Deep-field validation: the parsed envelope can be intact while the
      // numbers inside are garbage. A balance or rent that cannot be read
      // as a whole number is NEVER sanitized into zero or another default:
      // the account cannot be proven safely closable, so it is reported
      // and skipped like any other unreadable entry.
      if (
        typeof account.lamports !== "number" ||
        !Number.isInteger(account.lamports) ||
        account.lamports < 0 ||
        typeof info.tokenAmount !== "object" ||
        info.tokenAmount === null ||
        typeof info.tokenAmount.amount !== "string" ||
        !/^\d+$/.test(info.tokenAmount.amount)
      ) {
        skippedAccounts.push({
          pubkey: pubkey.toString(),
          mint: info.mint,
          reason: "response could not be read (malformed RPC data)",
          program: tag,
          cause: "unreadable",
        });
        continue;
      }

      // --- The five eligibility checks ---
      //
      // These are stricter than the protocol minimum. The on-chain program
      // only enforces check #1 (zero balance). We add the rest defensively
      // to avoid breaking a user's intentional setup. Failed accounts are
      // reported (not hidden) so the scan is verifiable by the user. Check
      // #2 marks instead of failing: a delegated account stays eligible and
      // gets its Revoke before the close, but checks #3-#5 still apply to it.

      // 1. Zero token balance. The main rule.
      //    If this fails, the account holds tokens and must NEVER be closed.
      //    A FROZEN funded account is a special kind of stuck: transfer
      //    rejects frozen on both sides, burn rejects frozen, and close
      //    needs a zero balance, so only the mint's freeze authority can
      //    ever release it (source-verified in both token programs
      //    2026-09-19). "Holds a token balance" would read as solvable, so
      //    the reason names the authority that owns the switch instead.
      const amount = BigInt(info.tokenAmount.amount);
      if (amount !== 0n) {
        skippedAccounts.push({
          pubkey: pubkey.toString(),
          mint: info.mint,
          reason:
            info.state === "frozen"
              ? "is frozen by the token's freeze authority"
              : "holds a token balance",
          program: tag,
          cause: "funded",
          balance: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
          lamports: account.lamports,
          ...(info.delegate ? { delegated: true } : {}),
          ...(info.state === "frozen" ? { frozen: true } : {}),
        });
        continue;
      }

      // 2. Active delegation: mark, don't skip.
      //    The balance check above guarantees the account is EMPTY by the
      //    time we get here. An empty delegated account still locks the
      //    owner's rent, and the owner can revoke the delegation and close
      //    in one transaction, so it stays eligible with a needsRevoke flag
      //    that the close builder turns into a Revoke instruction right
      //    before this account's CloseAccount. Checks #3-#5 below still
      //    apply: a delegated account with a foreign close authority or
      //    wrapped SOL is still skipped, and a delegated FROZEN account is
      //    skipped too because the on-chain Revoke itself rejects frozen
      //    accounts (AccountFrozen in both programs).
      //    NOTE: the parsed RPC response OMITS the delegate field entirely
      //    when there is no delegation. A naive `info.delegate !== null`
      //    check is WRONG because a missing field is undefined, and
      //    undefined !== null is true, which would flag every account as
      //    delegated. The correct check is Boolean().
      const needsRevoke = Boolean(info.delegate);

      // 3. Close authority still with the owner.
      //    Accounts created by other programs (DeFi auxiliaries, spam
      //    infrastructure) can carry a close authority that is not the
      //    wallet owner. Only the close authority can sign a closeAccount,
      //    so offering these would build a transaction that always fails.
      //    Same Boolean() pattern as the delegate check: the parsed
      //    response omits the field entirely when it is unset.
      if (info.closeAuthority && info.closeAuthority !== owner.toString()) {
        skippedAccounts.push({
          pubkey: pubkey.toString(),
          mint: info.mint,
          reason: "close authority belongs to another address",
          program: tag,
          cause: "close-authority",
        });
        continue;
      }

      // 4. Not wrapped SOL. Native accounts have special closing semantics
      //    that are out of scope for v1.
      const isNative = info.isNative !== false;
      if (isNative) {
        skippedAccounts.push({
          pubkey: pubkey.toString(),
          mint: info.mint,
          reason: "is a wrapped-SOL account",
          program: tag,
          cause: "wrapped-sol",
        });
        continue;
      }

      // 5. Account state. Frozen empty accounts ARE closeable: chain-verified
      //    2026-09-19 (a real frozen account closed with err null in a devnet
      //    simulation) and confirmed against both token programs' source,
      //    where neither CloseAccount path consults the frozen bit (it guards
      //    transfers, burns, approvals, and revokes only). The one exception
      //    is an account that still has an active delegate: the Revoke we
      //    emit before its close DOES reject frozen accounts (AccountFrozen
      //    in both programs), so that combination stays skipped. Truly
      //    uninitialized accounts cannot be closed at all and stay skipped.
      if (info.state === "uninitialized") {
        skippedAccounts.push({
          pubkey: pubkey.toString(),
          mint: info.mint,
          reason: "is not initialized",
          program: tag,
          cause: "uninitialized",
        });
        continue;
      }
      if (info.state === "frozen" && needsRevoke) {
        skippedAccounts.push({
          pubkey: pubkey.toString(),
          mint: info.mint,
          reason: "is frozen with an active delegate",
          program: tag,
          cause: "frozen-with-delegate",
          delegated: true,
        });
        continue;
      }

      // All five checks passed. This account is safe to close.
      eligibleAccounts.push({
        pubkey: pubkey.toString(),
        mint: info.mint,
        lamports: account.lamports,
        program: tag,
        ...(needsRevoke ? { needsRevoke: true } : {}),
        ...(info.state === "frozen" ? { frozen: true } : {}),
      });
      recoverableLamports += BigInt(account.lamports);
    }
  }

  return {
    totalAccounts,
    eligibleAccounts,
    recoverableLamports,
    skippedAccounts,
  };
}

/**
 * Convert lamports to a human-readable SOL string.
 * 1 SOL = 1,000,000,000 lamports.
 */
export function lamportsToSol(lamports: bigint): string {
  const sol = Number(lamports) / 1_000_000_000;
  return sol.toFixed(6);
}
