/**
 * The Token-2022 extension close-blocker check.
 *
 * The on-chain CloseAccount instruction refuses a Token-2022 account
 * whose extensions hold a balance: a non-zero withheld transfer fee
 * (TransferFeeAmount), or a non-zero encrypted balance in the privacy
 * extensions (ConfidentialTransferAccount pending_balance_lo,
 * pending_balance_hi, or available_balance, or the
 * ConfidentialTransferFeeAmount withheld ciphertext). Those closable()
 * rules were verified against the Token-2022 program source at
 * program@v11.1.0 (interface crate, confidential_transfer/mod.rs and
 * confidential_transfer_fee/mod.rs) during the 2026-10 transaction
 * audit; the byte offsets below come from the same state structs and are
 * pinned by fixture tests.
 *
 * The parsed RPC response the scan reads omits extensions entirely, so
 * this module re-reads the raw account data and decodes the extension
 * list. It checks ONLY the three blocking extensions: most Token-2022
 * accounts carry extensions that do not block a close (every Token-2022
 * ATA is created with ImmutableOwner), so "has any extension" would
 * wrongly hide healthy accounts.
 *
 * Dependency facts this rests on, both pinned by tests: the SDK 0.4.15
 * decodes TransferFeeAmount natively (TransferFeeAmountLayout) and
 * carries the ConfidentialTransferAccount type id (5) in its enum, but
 * ships no state decoder for it and no ConfidentialTransferFeeAmount at
 * all (its enum stops at the commented-out placeholder); the two
 * confidential checks are therefore hand walks over the typed-length-
 * value list using the SDK's type-agnostic getExtensionData, with the
 * confidential-fee type taken from the program's enum as 17. The SDK
 * and program enum numberings were cross-checked equal for every shared
 * value.
 *
 * Pure TypeScript plus one chunked RPC read. Nothing here builds,
 * signs, or sends anything.
 */

import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TransferFeeAmountLayout,
  TRANSFER_FEE_AMOUNT_SIZE,
  getExtensionData,
  unpackAccount,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type {
  AccountInfo,
  Commitment,
  GetMultipleAccountsConfig,
} from "@solana/web3.js";

export type CloseBlocker = "withheld-fee" | "confidential-balance";

/**
 * The ConfidentialTransferAccount window this check reads: three 64-byte
 * ElGamal ciphertexts. On-chain offsets inside the extension value:
 * pending_balance_lo at 33 (after the 1-byte approved flag and the
 * 32-byte elgamal pubkey), pending_balance_hi at 97, available_balance
 * at 161. The on-chain closable rule compares each against the zeroed
 * ciphertext, which in bytes is all zeros, so a byte compare mirrors it
 * exactly.
 */
const CONFIDENTIAL_TRANSFER_BALANCES_START = 33;
const CONFIDENTIAL_TRANSFER_BALANCES_END = 225; // 33 + 3 * 64

/** One ElGamal ciphertext in bytes (two curve points). */
const ENCRYPTED_BALANCE_SIZE = 64;

/** ConfidentialTransferFeeAmount in the on-chain extension enum. The SDK
 *  0.4.15 enum does not carry this type (it sits in the commented-out
 *  placeholder range), so the program's value is used directly. */
const CONFIDENTIAL_TRANSFER_FEE_AMOUNT_TYPE = 17 as ExtensionType;

function anyNonZero(buffer: Buffer, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (buffer[i] !== 0) return true;
  }
  return false;
}

/**
 * Classify one account's extension list. Returns the blocker that stops
 * a close, or null when nothing in the extensions blocks it. Extension
 * types this checker does not know (anything newer) pass through
 * unheard. Throws when a blocking extension is present but shorter than
 * its on-chain layout: that account cannot be judged, and the caller
 * treats it as unreadable rather than guessing.
 */
export function classifyCloseBlockers(tlvData: Buffer): CloseBlocker | null {
  const fee = getExtensionData(ExtensionType.TransferFeeAmount, tlvData);
  if (fee !== null) {
    if (fee.length < TRANSFER_FEE_AMOUNT_SIZE) {
      throw new Error("withheld-fee extension is shorter than its layout");
    }
    const { withheldAmount } = TransferFeeAmountLayout.decode(fee);
    if (withheldAmount > 0n) {
      return "withheld-fee";
    }
  }

  const confidential = getExtensionData(
    ExtensionType.ConfidentialTransferAccount,
    tlvData
  );
  if (confidential !== null) {
    if (confidential.length < CONFIDENTIAL_TRANSFER_BALANCES_END) {
      throw new Error(
        "confidential-transfer extension is shorter than its layout"
      );
    }
    if (
      anyNonZero(
        confidential,
        CONFIDENTIAL_TRANSFER_BALANCES_START,
        CONFIDENTIAL_TRANSFER_BALANCES_END
      )
    ) {
      return "confidential-balance";
    }
  }

  const confidentialFee = getExtensionData(
    CONFIDENTIAL_TRANSFER_FEE_AMOUNT_TYPE,
    tlvData
  );
  if (confidentialFee !== null) {
    if (confidentialFee.length < ENCRYPTED_BALANCE_SIZE) {
      throw new Error("confidential-fee extension is shorter than its layout");
    }
    if (anyNonZero(confidentialFee, 0, ENCRYPTED_BALANCE_SIZE)) {
      return "confidential-balance";
    }
  }

  return null;
}

export type CloseBlockerRead =
  | { status: "clear" }
  | { status: "blocked"; blocker: CloseBlocker }
  | { status: "unreadable" };

/** getMultipleAccountsInfo accepts at most 100 keys per request. */
const READ_CHUNK_SIZE = 100;

/** The one RPC boundary this module touches, as a minimal structural
 *  type (the real Connection satisfies it; tests mock exactly this). */
interface RawAccountReader {
  getMultipleAccountsInfo(
    keys: PublicKey[],
    config?: Commitment | GetMultipleAccountsConfig
  ): Promise<Array<{ owner: PublicKey; data: Buffer } | null>>;
}

function readOne(
  pubkey: string,
  info: { owner: PublicKey; data: Buffer } | null
): CloseBlockerRead {
  try {
    if (info === null) {
      return { status: "unreadable" };
    }
    // unpackAccount validates the owning program and the account shape,
    // then returns the extension list; the cast widens the minimal
    // structural read to the AccountInfo it already is.
    const account = unpackAccount(
      new PublicKey(pubkey),
      info as AccountInfo<Buffer>,
      TOKEN_2022_PROGRAM_ID
    );
    const blocker = classifyCloseBlockers(account.tlvData);
    return blocker === null
      ? { status: "clear" }
      : { status: "blocked", blocker };
  } catch {
    // The account moved (recreated under another owner or program), or
    // its data cannot be decoded. Either way it cannot be judged:
    // report, never guess.
    return { status: "unreadable" };
  }
}

/**
 * Read and classify the extension state of the given Token-2022 account
 * pubkeys in chunked batches (100 keys per call). A chunk call that
 * itself fails is an RPC failure and propagates to the scan's error
 * surface; only per-account anomalies (vanished, foreign-owner
 * recreation, malformed data) come back as unreadable.
 */
export async function readCloseBlockers(
  connection: RawAccountReader,
  pubkeys: string[]
): Promise<Map<string, CloseBlockerRead>> {
  const reads = new Map<string, CloseBlockerRead>();
  for (let i = 0; i < pubkeys.length; i += READ_CHUNK_SIZE) {
    const chunk = pubkeys.slice(i, i + READ_CHUNK_SIZE);
    const infos = await connection.getMultipleAccountsInfo(
      chunk.map((key) => new PublicKey(key))
    );
    for (let j = 0; j < chunk.length; j++) {
      reads.set(chunk[j], readOne(chunk[j], infos[j] ?? null));
    }
  }
  return reads;
}
