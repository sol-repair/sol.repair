/**
 * Authority naming + Token-2022 mint name resolution (the v2 spec,
 * docs/authority-naming-spec-draft.md). Display evidence only: the scan
 * attaches labels and names to the entries it already produces, and
 * nothing here changes any eligibility, skip, fee, batching, or retry
 * decision.
 *
 * Three pieces:
 *
 *  1. The known-authority registry (spec 3.1): a plain string map of
 *     verified addresses to labels. Program IDs carry no private key
 *     and never produce an ed25519 signature, so a token account whose
 *     close authority is a program can never have that close signed.
 *     Extensible by a one-line entry with a verified address; do not
 *     add third-party protocol names without first-hand verification
 *     of both address and behavior.
 *  2. The imitation detector (spec 3.2): the observed lock authorities
 *     begin with long runs of the base58 character "1" - the system
 *     program's address is exactly 32 of them - while not being the
 *     system program. Leading base58 ones encode leading zero bytes, so
 *     a key from ordinary keypair generation does not start with a run
 *     of them; addresses with a run of leading ones like this are
 *     deliberately generated (vanity). Twelve or more leading ones on a
 *     non-system address is labeled a lookalike. A lookalike address is
 *     a REAL pubkey someone may control: the label never claims it
 *     cannot sign, and it states no intent.
 *  3. The Token-2022 mint name/symbol decode (spec 3.4): the metadata
 *     extension stores a self-declared name and symbol on the mint
 *     itself, so reading it is a plain RPC read, not a registry lookup.
 *  4. The mint authority and freeze authority decode (the mint and
 *     freeze authority display spec, docs/mint-authority-display-spec-
 *     draft.md Rev 1): one mint account layout, two authority fields,
 *     classic SPL from the 82-byte mint layout's offsets, Token-2022
 *     via unpackMint. Both decode paths were re-verified against live
 *     chain data before this code was written (WSOL and USDC for the
 *     classic offsets, a live Token-2022 mint cross-checked between
 *     unpackMint and the same offsets).
 *
 * THE v2 LINE AMENDMENT, RECORDED HERE PER SPEC SECTION 5 (not
 * silently): the v2 spec line "classic mints stay address plus a
 * Solscan link" is amended - classic mints may carry on-chain
 * authority facts read through the app's own RPC path, display-only.
 * The ban on third-party registries and third-party name lookups is
 * UNCHANGED and remains a hard line. Nothing in this module adds any
 * third-party call.
 *
 * Dependency facts, verified in the implementation gate (the M1/M2
 * pattern) and pinned by fixture tests: the SDK 0.4.15 ships the pure
 * decode path (unpackMint -> getExtensionData(TokenMetadata) ->
 * spl-token-metadata's unpack) and it decodes real chain data; its
 * getTokenMetadata action was NOT used because it performs one fetch
 * per mint, and the spec mandates one chunked getMultipleAccountsInfo
 * read. The extension value is not discriminator-prefixed on-chain
 * (verified against a live metadata mint), so the SDK unpack applies
 * directly. unpack() throws on malformed bytes and getExtensionData
 * returns null when the extension is absent: both decode to "no
 * label". unpackMint validates the owning program and returns its two
 * authority fields as PublicKey | null (null = the raw option flag is
 * 0), throwing on malformed shapes: all of it decodes to "no facts".
 * @solana/spl-token-metadata is a runtime dependency of
 * @solana/spl-token (^0.1.6) and is imported directly here; package.json
 * is unchanged.
 *
 * NO THIRD-PARTY FETCHES, EVER (spec section 2, the hard privacy line):
 * every read rides the app's own Connection. Resolving classic mints
 * through a registry API would leak "this wallet holds these tokens" to
 * that service. Classic mints stay address + explorer link. This module
 * makes no direct network calls anywhere - the growth pin in tests
 * holds the set of fetch-containing files in src/ at exactly one (the
 * fee ledger's own RPC call).
 *
 * Pure TypeScript plus one chunked RPC read. Nothing here builds,
 * signs, or sends anything.
 */

import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getExtensionData,
  unpackMint,
} from "@solana/spl-token";
import { unpack } from "@solana/spl-token-metadata";
import { PublicKey } from "@solana/web3.js";
import type {
  AccountInfo,
  Commitment,
  GetMultipleAccountsConfig,
} from "@solana/web3.js";

/** The System Program's address: 32 base58 "1" characters. */
export const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

/** Verified authority addresses and their labels (spec 3.1, verbatim). */
const KNOWN_CLOSE_AUTHORITIES: Readonly<Record<string, string>> = {
  [SYSTEM_PROGRAM_ADDRESS]:
    "the system program. It cannot sign a token-account close.",
};

/** The lookalike label (spec 3.2, verbatim). It states what the address
 *  proves on its face and nothing else: no intent, and no claim that
 *  the address cannot sign. */
const IMITATION_LABEL =
  "has a long System Program-like address prefix. It is not the system program.";

/** Boundary pinned by tests: 11 leading ones label nothing, 12 label.
 *  Twelve leading base58 ones encode twelve leading zero bytes, which
 *  ordinary keypair generation does not produce, so only deliberate
 *  System Program lookalikes cross this line. */
const IMITATION_MIN_LEADING_ONES = 12;

/**
 * The label for a close-authority address, or null when nothing is
 * known. Registry first (so the real system program never gets the
 * imitation label), then the leading-ones detector.
 */
export function authorityLabel(address: string): string | null {
  const known = KNOWN_CLOSE_AUTHORITIES[address];
  if (known !== undefined) {
    return known;
  }
  let ones = 0;
  while (address[ones] === "1") {
    ones += 1;
  }
  if (ones >= IMITATION_MIN_LEADING_ONES) {
    return IMITATION_LABEL;
  }
  return null;
}

/** A mint's self-declared metadata. At least one field is non-empty. */
export interface MintNameSymbol {
  name?: string;
  symbol?: string;
}

/**
 * Decode a raw Token-2022 mint account's TokenMetadata extension into
 * name and symbol. Never throws: a mint owned by another program, a
 * missing extension, malformed bytes, or a vanished account all decode
 * to null (no label). The fields are self-declared metadata, displayed
 * as-is by the caller; they are not verified identity.
 */
export function decodeMintNameSymbol(
  mint: PublicKey,
  info: { owner: PublicKey; data: Buffer } | null
): MintNameSymbol | null {
  try {
    if (info === null) {
      return null;
    }
    // unpackMint validates the owning program and the mint shape (the
    // 165-byte base area plus the one-byte account type), then returns
    // the extension list - the same entry the M2 burn-blocker check
    // walks.
    const decoded = unpackMint(
      mint,
      info as AccountInfo<Buffer>,
      TOKEN_2022_PROGRAM_ID
    );
    const data = getExtensionData(ExtensionType.TokenMetadata, decoded.tlvData);
    if (data === null) {
      return null;
    }
    const meta = unpack(data);
    if (!meta.name && !meta.symbol) {
      return null;
    }
    return {
      ...(meta.name ? { name: meta.name } : {}),
      ...(meta.symbol ? { symbol: meta.symbol } : {}),
    };
  } catch {
    return null;
  }
}

/** A mint's on-chain authority states, decoded from the mint account
 *  itself. Both state booleans are present whenever the facts exist:
 *  "revoked" and "none" are themselves facts, not absence of reading.
 *  An address is carried only alongside an active state. */
export interface MintAuthorities {
  /** True when the mint authority is active (new supply can be
   *  printed), false when it is revoked. */
  mintAuthorityActive: boolean;
  /** Base58 address of the active mint authority. Present only when
   *  `mintAuthorityActive` is true. */
  mintAuthority?: string;
  /** True when a freeze authority exists, false when none does. */
  freezeAuthorityActive: boolean;
  /** Base58 address of the active freeze authority. Present only when
   *  `freezeAuthorityActive` is true. */
  freezeAuthority?: string;
}

/** A mint's read facts: the self-declared Token-2022 name and symbol
 *  where the mint carries them, plus the authority states. */
export type MintFacts = MintNameSymbol & MintAuthorities;

/** The classic SPL mint account's exact data length: the 82-byte mint
 *  layout, option u32 little-endian then the key, the freeze fields at
 *  offsets 46 and 50. Anything else owned by the classic program is
 *  not a mint layout and decodes to no facts. */
const CLASSIC_MINT_DATA_LENGTH = 82;

/**
 * Decode a raw mint account's mint authority and freeze authority.
 * Classic SPL mints decode from the 82-byte layout's offsets;
 * Token-2022 mints decode through unpackMint, the SDK path re-verified
 * against live chain data in the implementation gate. Never throws: a
 * vanished mint, an account owned by neither token program, a shape
 * that is not the mint layout, or malformed bytes all decode to null
 * (no facts). Fail toward showing nothing.
 */
export function decodeMintAuthorities(
  mint: PublicKey,
  info: { owner: PublicKey; data: Buffer } | null
): MintAuthorities | null {
  try {
    if (info === null) {
      return null;
    }
    if (info.owner.equals(TOKEN_PROGRAM_ID)) {
      if (info.data.length !== CLASSIC_MINT_DATA_LENGTH) {
        return null;
      }
      const mintAuthorityOption = info.data.readUInt32LE(0);
      const freezeAuthorityOption = info.data.readUInt32LE(46);
      if (mintAuthorityOption > 1 || freezeAuthorityOption > 1) {
        return null;
      }
      return {
        mintAuthorityActive: mintAuthorityOption === 1,
        ...(mintAuthorityOption === 1
          ? {
              mintAuthority: new PublicKey(
                info.data.subarray(4, 36)
              ).toBase58(),
            }
          : {}),
        freezeAuthorityActive: freezeAuthorityOption === 1,
        ...(freezeAuthorityOption === 1
          ? {
              freezeAuthority: new PublicKey(
                info.data.subarray(50, 82)
              ).toBase58(),
            }
          : {}),
      };
    }
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const decoded = unpackMint(
        mint,
        info as AccountInfo<Buffer>,
        TOKEN_2022_PROGRAM_ID
      );
      return {
        mintAuthorityActive: decoded.mintAuthority !== null,
        ...(decoded.mintAuthority !== null
          ? { mintAuthority: decoded.mintAuthority.toBase58() }
          : {}),
        freezeAuthorityActive: decoded.freezeAuthority !== null,
        ...(decoded.freezeAuthority !== null
          ? { freezeAuthority: decoded.freezeAuthority.toBase58() }
          : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** The one RPC boundary this module touches, as a minimal structural
 *  type (the real Connection satisfies it; tests mock exactly this). */
interface MintReader {
  getMultipleAccountsInfo(
    keys: PublicKey[],
    config?: Commitment | GetMultipleAccountsConfig
  ): Promise<Array<{ owner: PublicKey; data: Buffer } | null>>;
}

/** getMultipleAccountsInfo accepts at most 100 keys per request. */
const READ_CHUNK_SIZE = 100;

/**
 * Read the distinct mints' facts in chunked batches (100 keys per
 * call, the same cap discipline as the existing reads): the
 * self-declared Token-2022 name and symbol from the unchanged v2 name
 * decode, plus the mint and freeze authority states, all from the same
 * response bytes. Dedupe happens here, so one mint behind many
 * accounts is read once. A chunk call that fails is a failed read: no
 * facts for that chunk, and no throw - facts are display evidence, and
 * the scan's decisions never depend on them. A mint that decodes to
 * nothing has no entry in the result.
 */
export async function readMintFacts(
  connection: MintReader,
  mints: string[]
): Promise<Map<string, MintFacts>> {
  const facts = new Map<string, MintFacts>();
  const distinct = [...new Set(mints)];
  for (let i = 0; i < distinct.length; i += READ_CHUNK_SIZE) {
    const keys = distinct
      .slice(i, i + READ_CHUNK_SIZE)
      .map((mint) => new PublicKey(mint));
    let infos: Array<{ owner: PublicKey; data: Buffer } | null>;
    try {
      infos = await connection.getMultipleAccountsInfo(keys);
    } catch {
      continue;
    }
    for (let j = 0; j < keys.length; j++) {
      const info = infos[j] ?? null;
      const authorities = decodeMintAuthorities(keys[j], info);
      if (authorities === null) {
        continue;
      }
      const name = decodeMintNameSymbol(keys[j], info);
      facts.set(keys[j].toBase58(), {
        ...authorities,
        ...(name ?? {}),
      });
    }
  }
  return facts;
}
