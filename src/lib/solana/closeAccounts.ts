/**
 * Construction of CloseAccount instructions for eligible token accounts.
 *
 * When a token account is closed, the locked rent (lamports) is returned to
 * a destination account, and the token account is wiped from the blockchain.
 *
 * Safety properties enforced here:
 *   - The destination for recovered SOL is ALWAYS the user's own wallet.
 *     Never any other address. This is the whole point of the tool.
 *   - We only build instructions for accounts that already passed the five
 *     eligibility checks in tokenAccounts.ts. Defense in depth: even though
 *     the scan already validated these, we re-derive from the ClosableAccount
 *     list which only contains eligible accounts.
 *
 * No React in this file.
 */

import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createCloseAccountInstruction } from "@solana/spl-token";

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type ClosableAccount,
  type TokenProgram,
} from "./tokenAccounts";

const PROGRAM_IDS: Record<TokenProgram, PublicKey> = {
  spl: TOKEN_PROGRAM_ID,
  "token-2022": TOKEN_2022_PROGRAM_ID,
};

/**
 * Build CloseAccount instructions for the given eligible accounts.
 *
 * Each instruction closes one token account and sends its locked rent to
 * the owner's wallet. The instruction targets the token program that owns
 * the account (classic SPL or Token-2022). Each account is tagged at scan
 * time and the tag drives program selection here.
 *
 * Safety properties enforced here:
 *   - The destination for recovered SOL is ALWAYS the user's own wallet.
 *   - ONLY CloseAccount instructions are ever produced. No transfers, no
 *     approvals, no fee instructions mixed in. This is what wallet
 *     security scanners and the raw-tx inspector verify.
 *
 * @param accounts  The eligible accounts to close (from getClosableAccounts).
 * @param owner     The connected wallet. Recovered SOL goes here.
 * @returns         Array of CloseAccount instructions, one per account.
 */
export function buildCloseAccountInstructions(
  accounts: ClosableAccount[],
  owner: PublicKey
): TransactionInstruction[] {
  return accounts.map((account) =>
    createCloseAccountInstruction(
      new PublicKey(account.pubkey), // the token account to close
      owner, // destination: rent goes back to the user's own wallet
      owner, // authority: the wallet owner signs (close authority = owner)
      [], // no multisig signers
      PROGRAM_IDS[account.program] // owning program: SPL or Token-2022
    )
  );
}

/**
 * Verify on-chain which token accounts are actually closed.
 *
 * Why this exists: some wallets (Phantom notably, when the user confirms a
 * transaction that failed the wallet's own simulation) sign the transaction
 * AND submit it themselves. If our app then submits its copy, the network
 * rejects it ("account already closed" surfaces as InvalidAccountData in
 * simulation). That is NOT a repair failure - the repair already happened
 * via the wallet's submission.
 *
 * The only source of truth is the chain itself: an account is closed when it
 * either no longer exists or is no longer owned by the SPL Token program. We
 * check that before ever reporting failure to the user.
 *
 * Returns the pubkeys partitioned into closed/still-open so callers can also
 * report partial progress when a multi-transaction repair stops midway.
 */
export async function verifyAccountsClosed(
  connection: Connection,
  accounts: ClosableAccount[]
): Promise<{ closedPubkeys: string[]; stillOpenPubkeys: string[] }> {
  const closedPubkeys: string[] = [];
  const stillOpenPubkeys: string[] = [];

  for (const account of accounts) {
    const info = await connection.getAccountInfo(
      new PublicKey(account.pubkey),
      // "confirmed" matches the commitment the repair's confirmation
      // waits on. The RPC default ("finalized") lags the chain by
      // ~12 seconds, so in the wallet-self-submission race this
      // function exists for, a finalized read still sees the
      // accounts open and turns a succeeded repair into a false
      // failure. Verify against the same view confirmation used.
      "confirmed"
    );
    // A closed token account either no longer exists (null - fully cleaned
    // up) or is no longer owned by either token program (classic SPL or
    // Token-2022).
    const stillTokenOwned =
      info !== null &&
      (info.owner.equals(TOKEN_PROGRAM_ID) ||
        info.owner.equals(TOKEN_2022_PROGRAM_ID));
    if (stillTokenOwned) {
      stillOpenPubkeys.push(account.pubkey);
    } else {
      closedPubkeys.push(account.pubkey);
    }
  }

  return { closedPubkeys, stillOpenPubkeys };
}
