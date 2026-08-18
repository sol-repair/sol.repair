/**
 * Wallet scanning and account eligibility classification.
 *
 * This is the safety-critical core of SOL.repair. The five eligibility checks
 * encoded here decide which accounts are safe to close. Getting this right is
 * everything: if we wrongly mark a funded account as closeable, a user could
 * lose tokens.
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
}

/** An account we skip on purpose, with the reason.
 *  Shown to the user so the scan is verifiable, not a black box. */
export interface SkippedAccount {
  pubkey: string;
  mint: string;
  /** Human-readable eligibility-check failure. */
  reason: string;
  program: TokenProgram;
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
      const info = (account.data as { parsed: { info: TokenAccountInfo } })
        .parsed.info;

      // --- The five eligibility checks ---
      //
      // These are stricter than the protocol minimum. The on-chain program
      // only enforces check #1 (zero balance). We add the rest defensively
      // to avoid breaking a user's intentional setup. Failed accounts are
      // reported (not hidden) so the scan is verifiable by the user.

      // 1. Zero token balance. The main rule.
      //    If this fails, the account holds tokens and must NEVER be closed.
      const amount = BigInt(info.tokenAmount.amount);
      if (amount !== 0n) {
        skippedAccounts.push({
          pubkey: pubkey.toString(),
          mint: info.mint,
          reason: "holds a token balance",
          program: tag,
        });
        continue;
      }

      // 2. No active delegation.
      //    NOTE: the parsed RPC response OMITS the delegate field entirely
      //    when there is no delegation. A naive `info.delegate !== null`
      //    check is WRONG because a missing field is undefined, and
      //    undefined !== null is true, which would flag every account as
      //    delegated. The correct check is Boolean().
      const isDelegated = Boolean(info.delegate);
      if (isDelegated) {
        skippedAccounts.push({
          pubkey: pubkey.toString(),
          mint: info.mint,
          reason: "has an active delegation",
          program: tag,
        });
        continue;
      }

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
        });
        continue;
      }

      // 5. Initialized state. Frozen and uninitialized accounts need special
      //    handling and are skipped in v1.
      if (info.state !== "initialized") {
        skippedAccounts.push({
          pubkey: pubkey.toString(),
          mint: info.mint,
          reason: `is ${info.state} (not initialized)`,
          program: tag,
        });
        continue;
      }

      // All five checks passed. This account is safe to close.
      eligibleAccounts.push({
        pubkey: pubkey.toString(),
        mint: info.mint,
        lamports: account.lamports,
        program: tag,
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
