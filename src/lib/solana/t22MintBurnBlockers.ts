/**
 * The Token-2022 mint-side burn blockers.
 *
 * The on-chain standard Burn instruction refuses to run on mints that
 * carry certain extensions, verified against the Token-2022 program
 * source at program@v11.1.0 (process_burn):
 *
 *   - PermissionedBurnConfig with an authority set: standard Burn is
 *     rejected with InvalidInstruction (a permissioned burn with the
 *     mint's burn authority as an extra signer is required instead).
 *     A config whose authority is null (all-zero on-chain) does NOT
 *     block the standard burn.
 *   - A paused PausableConfig: MintPaused. An unpaused config does not
 *     block.
 *   - ConfidentialMintBurn present: IllegalMintBurnConversion. Presence
 *     alone blocks the standard burn.
 *
 * Everything else — transfer-fee configs, metadata pointers, any other
 * or newer extension — must pass unheard: those are common and do not
 * block a burn. These "must pass" cases are fixture-pinned guards.
 *
 * Dependency facts (both fixture-pinned): the SDK 0.4.15 decodes
 * PausableConfig (authority + paused bool) and PermissionedBurn (the
 * authority) natively; ConfidentialMintBurn is absent from the SDK
 * enum, so the program's extension type 42 is used directly with the
 * SDK's type-agnostic getExtensionData, the same one-line hand walk the
 * close-blocker check uses. Extension data for a mint begins after the
 * 165-byte base area with a one-byte account type; unpackMint validates
 * that shape, which is also what catches a mint owned by another
 * program.
 *
 * Pure TypeScript plus one single-account RPC read. Nothing here
 * builds, signs, or sends anything.
 */

import {
  ExtensionType,
  PausableConfigLayout,
  PermissionedBurnLayout,
  TOKEN_2022_PROGRAM_ID,
  getExtensionData,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { AccountInfo, Commitment } from "@solana/web3.js";

export type MintBurnBlocker =
  | "permissioned-burn"
  | "paused"
  | "confidential-mint-burn";

/** ConfidentialMintBurn in the on-chain extension enum. The SDK 0.4.15
 *  enum does not carry this type; the value comes from the program
 *  source (instruction pack, tag 42 for the extension instruction and
 *  the extension enum). */
const CONFIDENTIAL_MINT_BURN_TYPE = 42 as ExtensionType;

/**
 * Classify one mint's extension list. Returns the blocker that stops a
 * standard burn, or null when nothing blocks it. Extension types this
 * checker does not know pass unheard. Throws when a blocking extension
 * is present but shorter than its layout: that mint cannot be judged,
 * and the caller treats it as unreadable rather than guessing.
 */
export function classifyMintBurnBlockers(
  tlvData: Buffer
): MintBurnBlocker | null {
  const pausable = getExtensionData(ExtensionType.PausableConfig, tlvData);
  if (pausable !== null) {
    if (pausable.length < PausableConfigLayout.span) {
      throw new Error("pausable extension is shorter than its layout");
    }
    const { paused } = PausableConfigLayout.decode(pausable);
    if (paused) {
      return "paused";
    }
  }

  const permissioned = getExtensionData(
    ExtensionType.PermissionedBurn,
    tlvData
  );
  if (permissioned !== null) {
    if (permissioned.length < PermissionedBurnLayout.span) {
      throw new Error("permissioned-burn extension is shorter than its layout");
    }
    const { authority } = PermissionedBurnLayout.decode(permissioned);
    // On-chain null authority is the all-zero pubkey; only a set
    // authority blocks the standard burn.
    if (!authority.equals(PublicKey.default)) {
      return "permissioned-burn";
    }
  }

  if (getExtensionData(CONFIDENTIAL_MINT_BURN_TYPE, tlvData) !== null) {
    return "confidential-mint-burn";
  }

  return null;
}

export type MintBurnRead =
  | { status: "clear" }
  | { status: "blocked"; blocker: MintBurnBlocker }
  | { status: "unreadable" };

/** The one RPC boundary this module touches, as a minimal structural
 *  type (the real Connection satisfies it; tests mock exactly this).
 *  web3.js's getAccountInfo already unwraps the RPC envelope and
 *  returns the AccountInfo directly. */
interface MintReader {
  getAccountInfo(
    pubkey: PublicKey,
    commitment?: Commitment
  ): Promise<{ owner: PublicKey; data: Buffer } | null>;
}

/**
 * Read and classify one mint. Never throws: a vanished mint, a mint
 * owned by another program, malformed data, or an RPC failure all come
 * back as unreadable, and the caller aborts conservatively (fail toward
 * not promising, the owner's standing ruling).
 */
export async function readMintBurnBlockers(
  connection: MintReader,
  mint: string
): Promise<MintBurnRead> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(mint));
    if (info === null) {
      return { status: "unreadable" };
    }
    // unpackMint validates the owning program and the mint shape, then
    // returns the extension list.
    const decoded = unpackMint(
      new PublicKey(mint),
      info as AccountInfo<Buffer>,
      TOKEN_2022_PROGRAM_ID
    );
    const blocker = classifyMintBurnBlockers(decoded.tlvData);
    return blocker === null
      ? { status: "clear" }
      : { status: "blocked", blocker };
  } catch {
    return { status: "unreadable" };
  }
}
