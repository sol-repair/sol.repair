/**
 * Dead-NFT burn-and-close, v1 slice (docs/dead-nft-scope-memo-
 * 2026-11.md, owner build word 2026-11-13). For a classic-program,
 * master-edition-backed NFT the user explicitly chooses, one
 * hand-built Metaplex BurnNft instruction (tag 29) burns the single
 * token and closes three accounts: the token account, the metadata
 * PDA, and the master edition PDA - the metadata and edition rent is
 * what the existing dust burn strands permanently (memo section 1.6,
 * FACT from program source). The 1% fee rides on the sum of the three
 * accounts' pre-balances, supplied to the existing buildFeeTransfer;
 * fees.ts stays byte-identical.
 *
 * The wire is VERIFIED against the metadata program source saved by
 * the exploration thread (memo section 3.1; sources in
 * .verify-tmp/dead-nft-scope/sources/):
 *   - program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s, data exactly
 *     one byte, 29 (the generated BurnNft.ts discriminator);
 *   - account order metadata, owner (writable, the only signer), mint,
 *     token account, master edition, SPL token program, optional
 *     collection metadata PDA (writable) required iff
 *     metadata.collection.verified;
 *   - on chain the instruction burns via CPI, closes the token account,
 *     closes metadata, closes the master edition, and decrements a
 *     sized verified collection (nonfungible.rs:65-103);
 *   - the assertions it enforces are pre-checked by the gate: owner
 *     match, mint match, token.amount == 1 (burn_nft.rs:66-68), the
 *     edition key is a master edition (V1 or V2 are both accepted,
 *     nonfungible.rs:27-29), edition supply == 0
 *     (MasterEditionHasPrints), and the correctly derived collection
 *     PDA when the collection is verified (an empty or burned
 *     collection account at the correct PDA is acceptable,
 *     nonfungible.rs:118-125).
 *
 * NOT in the v1 wire: Token-2022 NFTs (BurnNft hard-rejects, memo N5)
 * and print editions (key 1, memo N6). Both are honest scan rows, never
 * offers. Metadata-only NFTs (no edition account at all) get the
 * metadata-only terminal: the token account can still be closed through
 * the dust burn, and the metadata deposit is unreachable by anyone.
 *
 * Mirrors burnDust.ts structurally on purpose: the same single-read
 * discipline, the same gate shape shared by the hook (authoritative,
 * in-lock) and the confirmation card (presentation), and the same
 * builder rule that the preview can never drift from the signed
 * instruction objects. Routing rule (memo section 3.2): decimals 0,
 * supply 1, edition PDA alive with key 6 -> the NFT card; everything
 * else -> today's flow unchanged.
 *
 * No React in this file.
 */

import {
  Commitment,
  GetMultipleAccountsConfig,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type ScanResult,
  type TokenProgram,
} from "./tokenAccounts";

/** The Metaplex Token Metadata program (memo section 3.1). */
export const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

/** The BurnNft instruction tag: the wire's single data byte. */
export const BURN_NFT_TAG = 29;

/** The metadata program's account key bytes (state/mod.rs Key enum,
 *  read from the saved source; UNINITIALIZED = 0). */
export const KEY_UNINITIALIZED = 0;
export const EDITION_KEY_V1 = 1;
export const MASTER_EDITION_KEY_V1 = 2;
export const METADATA_KEY_V1 = 4;
export const MASTER_EDITION_KEY_V2 = 6;

/** The seeds the metadata program derives its PDAs from
 *  (nonfungible.rs edition_info_path; find_metadata_account). */
const METADATA_SEED = "metadata";
const EDITION_SEED = "edition";

export function findMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(METADATA_SEED), METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID
  )[0];
}

export function findMasterEditionPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(METADATA_SEED),
      METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
      Buffer.from(EDITION_SEED),
    ],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID
  )[0];
}

/* ------------------------------------------------------------------ */
/* Raw account parsers (the fixed layouts the burn flow reads)         */
/* ------------------------------------------------------------------ */

/** A strict sequential reader over an account's raw bytes. Every read
 *  is bounds-checked; any overrun marks the account unreadable (the
 *  null-on-garbage contract shared with the ledger decoder). */
class ByteReader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.offset;
  }

  take(count: number): Uint8Array {
    if (count < 0 || this.offset + count > this.data.length) {
      throw new RangeError("out of bounds");
    }
    const slice = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  u8(): number {
    return this.take(1)[0];
  }

  u16(): number {
    const b = this.take(2);
    return b[0] | (b[1] << 8);
  }

  u32(): number {
    const b = this.take(4);
    return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] * 0x1000000);
  }

  u64(): string {
    // Returned as a decimal string: supply and amount are exact u64s,
    // never floats.
    const b = this.take(8);
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) {
      value = (value << 8n) | BigInt(b[i]);
    }
    return value.toString();
  }

  pubkey(): string {
    return new PublicKey(this.take(32)).toBase58();
  }

  /** A borsh String: u32 length prefix + bytes. Null-padded display
   *  names are trimmed at the first NUL (the Metaplex convention). */
  borshString(): string {
    const length = this.u32();
    const bytes = this.take(length);
    let end = bytes.indexOf(0);
    if (end === -1) end = bytes.length;
    return new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.subarray(0, end))
      .trim();
  }
}

export interface ParsedNftMetadata {
  /** The mint the metadata account names (bytes 33..65) - the identity
   *  cross-check for the gate. */
  mint: string;
  /** The self-declared display name, or null when the field could not
   *  be read. Displayed as-is, never a verified identity (the same
   *  discipline as the Token-2022 mintName evidence). */
  name: string | null;
  collectionVerified: boolean;
  /** The verified collection's mint, when the collection field names
   *  one; the collection metadata PDA derives from it. */
  collectionKey: string | null;
}

/**
 * Parse a metadata account's borsh body (state/metadata.rs Metadata:
 * key, update_authority, mint, Data{name, symbol, uri,
 * seller_fee_basis_points, creators Option<Vec<Creator>>},
 * primary_sale_happened, is_mutable, edition_nonce Option,
 * token_standard Option, collection Option {verified, key}, uses
 * Option, collection_details Option, programmable_config Option).
 * The offsets are VERIFIED against 120
 * real mainnet metadata accounts captured 2026-11-13 (the Saga Pass
 * and Pond of Dreams fixtures pin them). Returns null for any account
 * whose key byte is not MetadataV1 or whose body overruns - no
 * verdict, never a guess.
 */
export function parseNftMetadata(data: Uint8Array): ParsedNftMetadata | null {
  try {
    const reader = new ByteReader(data);
    const key = reader.u8();
    if (key !== METADATA_KEY_V1) return null;
    reader.take(32); // update authority
    const mint = reader.pubkey();
    const parsedName = reader.borshString();
    const name = parsedName === "" ? null : parsedName;
    reader.borshString(); // symbol
    reader.borshString(); // uri
    reader.u16(); // seller_fee_basis_points
    if (reader.u8() === 1) {
      const creators = reader.u32();
      reader.take(creators * 34);
    }
    reader.u8(); // primary_sale_happened
    reader.u8(); // is_mutable
    if (reader.u8() === 1) reader.u8(); // edition_nonce
    if (reader.u8() === 1) reader.u8(); // token_standard
    let collectionVerified = false;
    let collectionKey: string | null = null;
    if (reader.u8() === 1) {
      // The Collection struct is { verified: bool, key: Pubkey } -
      // VERIFIED FIRST (state/collection.rs, fetched 2026-11-13; the
      // exploration census parsed it in this order too).
      collectionVerified = reader.u8() === 1;
      collectionKey = reader.pubkey();
    }
    // The uses Option trails the collection and is never read: the
    // burn flow does not consult it, and a truncated body after the
    // collection field would not change any decision above.
    return { mint, name, collectionVerified, collectionKey };
  } catch {
    return null;
  }
}

export interface ParsedNftEdition {
  /** The account's key byte (state/mod.rs Key enum): 6 MasterEditionV2,
   *  2 MasterEditionV1, 1 print EditionV1. */
  key: number;
  /** The supply the burn flow reads (nonfungible.rs: bytes 1..9, LE
   *  u64), when the account is long enough to hold it. MasterEditionV1
   *  and V2 share the layout prefix; print editions carry no supply
   *  field (null). */
  supply: string | null;
}

/**
 * Parse the edition PDA's body the way the on-chain burn reads it:
 * byte 0 is the key, bytes 1..9 the supply. A print edition (key 1)
 * has a different body shape and reports supply null. Null on any
 * account too short to hold the two reads.
 */
export function parseNftEdition(data: Uint8Array): ParsedNftEdition | null {
  try {
    const reader = new ByteReader(data);
    const key = reader.u8();
    if (key === EDITION_KEY_V1) {
      return { key, supply: null };
    }
    const supply = reader.u64();
    return { key, supply };
  } catch {
    return null;
  }
}

export interface ParsedTokenBase {
  mint: string;
  owner: string;
  /** Exact base-unit amount as a decimal string. */
  amount: string;
  /** The parsed account state byte (1 initialized, 2 frozen), read
   *  from byte 108 of the 165-byte base layout both token programs
   *  share; extensions never prepend. */
  frozen: boolean;
}

/** Parse a token account's 165-byte base layout (mint, owner, amount,
 *  delegate COption, state, is_native COption, delegated_amount,
 *  close_authority COption). Works for classic and Token-2022 alike:
 *  the base fields are a prefix and extensions append. Null for data
 *  shorter than the layout. */
export function parseClassicTokenAccount(data: Uint8Array): ParsedTokenBase | null {
  try {
    const reader = new ByteReader(data);
    const mint = reader.pubkey();
    const owner = reader.pubkey();
    const amount = reader.u64();
    // delegate COption (36 bytes) then the state byte at 108:
    // 1 initialized, 2 frozen; anything else is not a readable token
    // account for this purpose.
    if (reader.remaining < 37) return null;
    reader.take(36);
    const state = reader.u8();
    if (state !== 1 && state !== 2) return null;
    return { mint, owner, amount, frozen: state === 2 };
  } catch {
    return null;
  }
}

/** Parse a mint account's base layout (authority COption, supply u64
 *  at 36..44, decimals at 44, is_initialized at 45). Works for classic
 *  and Token-2022: the base mint is a 82-byte prefix and extensions
 *  append. Null for uninitialized or short data. */
export function parseMintBase(data: Uint8Array): {
  decimals: number;
  supply: string;
} | null {
  try {
    const reader = new ByteReader(data);
    reader.take(36); // mint authority COption
    const supply = reader.u64();
    const decimals = reader.u8();
    const initialized = reader.u8();
    if (initialized !== 1) return null;
    return { decimals, supply };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Selection: which scan skips are NFT candidates at all               */
/* ------------------------------------------------------------------ */

/** One decimals-0 candidate the NFT detection will classify. Both
 *  token programs are selected: the classic one can become the
 *  burnable card, the Token-2022 one only ever becomes an honest row
 *  (the v1 wire rejects Token-2022), and both must leave the dust
 *  section's blind spot covered by the pending-routing contract. */
export interface NftScanCandidate {
  /** The token account's public key, base58-encoded. */
  pubkey: string;
  mint: string;
  program: TokenProgram;
  /** All lamports the account holds at scan. */
  lamports: number;
  /** Balance at scan; an NFT carries exactly "1". */
  amountAtScan: string;
}

/**
 * Select the scan's funded decimals-0 accounts as NFT detection
 * candidates (memo section 3.2: the detection piggybacks the scan's
 * parsed walk, which already reads decimals per account). Evidence
 * completeness applies exactly as the dust selector's: lamports,
 * balance, and decimals validated, never defaulted; a foreign close
 * authority excludes (no burn flow can succeed); frozen candidates
 * stay IN (they become honest frozen rows, never offers); a wrapped-
 * SOL or unknown native status excludes (the unwrap flow's territory).
 */
export function selectNftScanCandidates(scan: ScanResult): NftScanCandidate[] {
  const out: NftScanCandidate[] = [];
  for (const entry of scan.skippedAccounts) {
    if (entry.cause !== "funded") continue;
    if (entry.frozen === true) {
      // Frozen funded accounts keep the honest-disclosure path: they
      // are selected and classified, and the frozen class never offers.
    }
    if (entry.nativeStatus !== "non-native") continue;
    if (entry.foreignCloseAuthority === true) continue;
    if (
      typeof entry.lamports !== "number" ||
      !Number.isInteger(entry.lamports) ||
      entry.lamports < 0
    ) {
      continue;
    }
    if (
      typeof entry.balance !== "string" ||
      !/^\d+$/.test(entry.balance) ||
      BigInt(entry.balance) <= 0n
    ) {
      continue;
    }
    if (typeof entry.decimals !== "number" || entry.decimals !== 0) continue;
    out.push({
      pubkey: entry.pubkey,
      mint: entry.mint,
      program: entry.program,
      lamports: entry.lamports,
      amountAtScan: entry.balance,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Detection reads (batched, the memo's 2-3 call shape)                */
/* ------------------------------------------------------------------ */

export type NftMintFact =
  | { status: "read"; decimals: number; supply: string; program: TokenProgram }
  | { status: "missing" }
  | { status: "unreadable" };

/** One chunked raw read over the candidates' mints. The mint base
 *  layout (supply at 36..44, decimals at 44) is a prefix both token
 *  programs share, so one read serves classic and Token-2022. Throws
 *  on RPC failure - the section owns the honest failed state. */
export async function readNftMintFacts(
  connection: {
    getMultipleAccountsInfo: (
      keys: PublicKey[]
    ) => Promise<Array<{ owner: PublicKey; data: Uint8Array } | null>>;
  },
  mints: string[]
): Promise<Map<string, NftMintFact>> {
  const facts = new Map<string, NftMintFact>();
  if (mints.length === 0) return facts;
  const keys = mints.map((m) => new PublicKey(m));
  // Public RPCs cap getMultipleAccounts at 100 keys per call; a chunk
  // over the cap is a hard error (a dropped chunk would silently hide
  // candidates), the same discipline as the excess detection.
  const CHUNK = 100;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const accounts = await connection.getMultipleAccountsInfo(chunk);
    for (let j = 0; j < chunk.length; j += 1) {
      const account = accounts[j];
      const mint = chunk[j].toBase58();
      if (!account) {
        facts.set(mint, { status: "missing" });
        continue;
      }
      const program: TokenProgram | null = account.owner.equals(
        TOKEN_PROGRAM_ID
      )
        ? "spl"
        : account.owner.equals(TOKEN_2022_PROGRAM_ID)
          ? "token-2022"
          : null;
      const base = program === null ? null : parseMintBase(account.data);
      facts.set(
        mint,
        base && program
          ? { status: "read", decimals: base.decimals, supply: base.supply, program }
          : { status: "unreadable" }
      );
    }
  }
  return facts;
}

export interface NftAccountTriple {
  token: string;
  metadata: string;
  edition: string;
}

export interface NftTripleRead {
  token:
    | { kind: "missing" }
    | { kind: "read"; program: TokenProgram; lamports: number; base: ParsedTokenBase };
  metadata: { kind: "missing" } | { kind: "read"; lamports: number; body: ParsedNftMetadata };
  edition:
    | { kind: "missing" }
    | { kind: "read"; lamports: number; body: ParsedNftEdition | null };
}

/** One chunked raw read over the derived triples (token account,
 *  metadata PDA, edition PDA). Metadata bodies parse with the fixed
 *  borsh layout; anything that overruns stays unreadable for that
 *  account and the classification fails toward not promising. Throws
 *  on RPC failure. */
export async function readNftTriples(
  connection: {
    getMultipleAccountsInfo: (
      keys: PublicKey[]
    ) => Promise<
      Array<{ owner: PublicKey; lamports: number; data: Uint8Array } | null>
    >;
  },
  triples: NftAccountTriple[]
): Promise<Map<string, NftTripleRead>> {
  const reads = new Map<string, NftTripleRead>();
  if (triples.length === 0) return reads;
  const CHUNK = 100;
  for (let i = 0; i < triples.length; i += CHUNK) {
    const chunk = triples.slice(i, i + CHUNK);
    const keys = chunk.flatMap((t) => [
      new PublicKey(t.token),
      new PublicKey(t.metadata),
      new PublicKey(t.edition),
    ]);
    const accounts = await connection.getMultipleAccountsInfo(keys);
    for (let j = 0; j < chunk.length; j += 1) {
      const token = accounts[j * 3];
      const metadata = accounts[j * 3 + 1];
      const edition = accounts[j * 3 + 2];
      const tokenBase = token
        ? token.owner.equals(TOKEN_PROGRAM_ID) ||
          token.owner.equals(TOKEN_2022_PROGRAM_ID)
          ? parseClassicTokenAccount(token.data)
          : null
        : null;
      const metadataBody =
        metadata && metadata.owner.equals(METAPLEX_TOKEN_METADATA_PROGRAM_ID)
          ? parseNftMetadata(metadata.data)
          : null;
      const read: NftTripleRead = {
        token:
          !token || tokenBase === null
            ? { kind: "missing" }
            : {
                kind: "read",
                program: token.owner.equals(TOKEN_2022_PROGRAM_ID)
                  ? "token-2022"
                  : "spl",
                lamports: token.lamports,
                base: tokenBase,
              },
        metadata:
          !metadata || metadataBody === null
            ? { kind: "missing" }
            : {
                kind: "read",
                lamports: metadata.lamports,
                body: metadataBody,
              },
        edition: !edition
          ? { kind: "missing" }
          : {
              kind: "read",
              lamports: edition.lamports,
              body: parseNftEdition(edition.data),
            },
      };
      reads.set(chunk[j].token, read);
    }
  }
  return reads;
}

/* ------------------------------------------------------------------ */
/* Classification (the routing truth table, memo section 3.2)          */
/* ------------------------------------------------------------------ */

export type NftClass =
  /** Master-edition-backed (key 6), unfrozen, one token: THE v1 card. */
  | "burnable"
  /** Master-backed but frozen: the N1 honest row, never an offer. */
  | "frozen"
  /** Master edition supply above 0: the N2 honest row. */
  | "has-prints"
  /** No edition PDA at all: the N7 metadata-only terminal. */
  | "metadata-only"
  /** Print edition at the edition address (key 1): the N6 row. */
  | "print-edition"
  /** MasterEditionV1 (key 2): routed only for key 6 in v1. */
  | "master-v1"
  /** Token-2022 NFT: the N5 row, a different instruction. */
  | "token22"
  /** Not an NFT (mint missing, unreadable, decimals above 0, supply
   *  above 1, or a shape mismatch): today's flow unchanged, no row. */
  | "not-nft";

export interface DetectedNft {
  candidate: NftScanCandidate;
  class: NftClass;
  /** Fresh lamports per account from the detection read (null when the
   *  account is missing). The fee base for a burnable NFT is the sum
   *  of all three. */
  tokenLamports: number | null;
  metadataLamports: number | null;
  editionLamports: number | null;
  /** The three-account fee base in lamports (0 for classes without a
   *  fee); for burnable rows this is what the 1% comes off. */
  rentLamports: number;
  /** Self-declared metadata name (display as-is, no verified identity). */
  name: string | null;
  collectionVerified: boolean;
  collectionKey: string | null;
  /** Self-declared name of the verified collection's own metadata
   *  account, when the collection batch read one. */
  collectionName: string | null;
  /** Master edition supply when the edition body carried one. */
  masterSupply: string | null;
  /** The edition account's key byte when one was read. */
  editionKey: number | null;
}

/**
 * The routing rule (memo section 3.2), pure: decimals 0 + supply 1 +
 * edition PDA alive with key 6 -> burnable; everything else -> its
 * honest class or today's flow (not-nft rows render nothing here and
 * stay in the dust flow unchanged).
 */
export function classifyNftCandidate(
  candidate: NftScanCandidate,
  mint: NftMintFact,
  token: NftTripleRead["token"],
  metadata: NftTripleRead["metadata"],
  edition: NftTripleRead["edition"]
): Omit<DetectedNft, "candidate"> {
  const base = {
    tokenLamports: token.kind === "read" ? token.lamports : null,
    metadataLamports: metadata.kind === "read" ? metadata.lamports : null,
    editionLamports: edition.kind === "read" ? edition.lamports : null,
    name: null as string | null,
    collectionVerified: false,
    collectionKey: null as string | null,
    collectionName: null as string | null,
    masterSupply: null as string | null,
    editionKey: null as number | null,
  };
  const finish = (
    class_: NftClass,
    over: Partial<Omit<DetectedNft, "candidate" | "class">> = {}
  ): Omit<DetectedNft, "candidate"> => ({
    ...base,
    ...over,
    class: class_,
    rentLamports:
      class_ === "burnable"
        ? (base.tokenLamports ?? 0) +
          (base.metadataLamports ?? 0) +
          (base.editionLamports ?? 0)
        : class_ === "metadata-only"
          ? (base.tokenLamports ?? 0) + (base.metadataLamports ?? 0)
          : 0,
  });

  // The mint read is the NFT test (memo section 3.2): decimals 0 and
  // supply 1. Anything else is today's flow, unchanged.
  if (mint.status !== "read") return finish("not-nft");
  if (mint.decimals !== 0 || mint.supply !== "1") return finish("not-nft");
  // The token account itself must still be a live, matching, 1-unit
  // account; a missing or mismatched token is nothing to offer.
  if (token.kind !== "read") return finish("not-nft");
  if (token.base.mint !== candidate.mint) return finish("not-nft");
  if (token.base.amount !== "1") return finish("not-nft");
  if (metadata.kind !== "read") return finish("not-nft");
  if (metadata.body.mint !== candidate.mint) return finish("not-nft");

  if (candidate.program === "token-2022") {
    return finish("token22", {
      name: metadata.body.name,
      collectionVerified: metadata.body.collectionVerified,
      collectionKey: metadata.body.collectionKey,
    });
  }
  if (edition.kind !== "read") {
    // No edition PDA at all: the N7 metadata-only class. The token and
    // metadata rents show, and the terminal sentence carries the
    // stranding truth.
    return finish("metadata-only", {
      name: metadata.body.name,
      collectionVerified: metadata.body.collectionVerified,
      collectionKey: metadata.body.collectionKey,
    });
  }
  const body = edition.body;
  if (body === null) {
    // An account sits at the edition address but is not a readable
    // edition: fail toward not promising, never an offer.
    return finish("not-nft", { name: metadata.body.name });
  }
  const common = {
    name: metadata.body.name,
    collectionVerified: metadata.body.collectionVerified,
    collectionKey: metadata.body.collectionKey,
    masterSupply: body.supply,
    editionKey: body.key,
  };
  if (body.key === MASTER_EDITION_KEY_V2 || body.key === MASTER_EDITION_KEY_V1) {
    if (body.supply !== null && BigInt(body.supply) > 0n) {
      return finish("has-prints", common);
    }
    if (token.base.frozen) {
      return finish("frozen", common);
    }
    // The v1 routing offers only MasterEditionV2 (key 6); a
    // MasterEditionV1 (key 2) is disclosed, not offered.
    return finish(
      body.key === MASTER_EDITION_KEY_V2 ? "burnable" : "master-v1",
      common
    );
  }
  if (body.key === EDITION_KEY_V1) {
    return finish("print-edition", common);
  }
  return finish("not-nft", { name: metadata.body.name });
}

/** The collection metadata PDAs the detection's third batch reads (the
 *  verified collections' own metadata accounts, for the collection
 *  name display). Empty when nothing detected is a verified collection
 *  member, so the median scan spends no extra call. */
export function collectionKeysOf(detected: DetectedNft[]): string[] {
  const keys = new Set<string>();
  for (const d of detected) {
    if (d.collectionVerified && d.collectionKey) keys.add(d.collectionKey);
  }
  return [...keys];
}

/** Attach the collection names a batch read produced. Pure. */
export function attachCollectionNames(
  detected: DetectedNft[],
  names: Map<string, string>
): DetectedNft[] {
  return detected.map((d) =>
    d.collectionVerified && d.collectionKey && names.has(d.collectionKey)
      ? { ...d, collectionName: names.get(d.collectionKey) ?? null }
      : d
  );
}

/** The third batched read: the verified collections' own metadata
 *  accounts, for the collection name a burn card can show. Skipped
 *  entirely when nothing detected is a verified-collection member, so
 *  the median scan spends no extra call. A collection account that is
 *  missing or unreadable simply contributes no name (the collection
 *  mint address still shows); it never blocks a row. */
export async function readCollectionNames(
  connection: {
    getMultipleAccountsInfo: (
      keys: PublicKey[]
    ) => Promise<
      Array<{ owner: PublicKey; lamports: number; data: Uint8Array } | null>
    >;
  },
  collectionMints: string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (collectionMints.length === 0) return names;
  const CHUNK = 100;
  for (let i = 0; i < collectionMints.length; i += CHUNK) {
    const chunk = collectionMints.slice(i, i + CHUNK).map((m) => new PublicKey(m));
    const accounts = await connection.getMultipleAccountsInfo(
      chunk.map((mint) => findMetadataPda(mint))
    );
    for (let j = 0; j < chunk.length; j += 1) {
      const account = accounts[j];
      if (!account) continue;
      const body = parseNftMetadata(account.data);
      if (body?.name) names.set(chunk[j].toBase58(), body.name);
    }
  }
  return names;
}

/** Detect the scan's NFT candidates (memo section 3.2): one batched
 *  read over the unique decimals-0 mints (the NFT test: decimals 0,
 *  supply 1), one over the derived token/metadata/edition triples
 *  (measured rent, edition key and supply, collection verified flag,
 *  frozen state), one over the verified collections' metadata when any
 *  exists. Throws on RPC failure - the section owns the honest failed
 *  state. Candidates whose reads do not prove an NFT class classify
 *  not-nft and stay in today's flow; nothing is invented for an
 *  unreadable account. */
export async function detectNftCandidates(
  connection: {
    getMultipleAccountsInfo: (
      keys: PublicKey[]
    ) => Promise<
      Array<{ owner: PublicKey; lamports: number; data: Uint8Array } | null>
    >;
  },
  candidates: NftScanCandidate[]
): Promise<DetectedNft[]> {
  if (candidates.length === 0) return [];
  // 1. The mint batch (the NFT test).
  const mints = [...new Set(candidates.map((c) => c.mint))];
  const mintFacts = await readNftMintFacts(connection, mints);
  // 2. The triple batch (token account, metadata PDA, edition PDA).
  const triples = candidates.map((c) => ({
    token: c.pubkey,
    metadata: findMetadataPda(new PublicKey(c.mint)).toBase58(),
    edition: findMasterEditionPda(new PublicKey(c.mint)).toBase58(),
  }));
  const tripleReads = await readNftTriples(connection, triples);
  // 3. Classification, then the collection-name batch only when a
  // verified collection exists (the median scan spends no extra call).
  let detected = candidates.map((candidate) => {
    const read = tripleReads.get(candidate.pubkey) as NftTripleRead;
    return {
      candidate,
      ...classifyNftCandidate(candidate, mintFacts.get(candidate.mint) ?? { status: "unreadable" }, read.token, read.metadata, read.edition),
    };
  });
  const collectionMints = collectionKeysOf(detected);
  if (collectionMints.length > 0) {
    const names = await readCollectionNames(connection, collectionMints);
    detected = attachCollectionNames(detected, names);
  }
  return detected;
}

/* ------------------------------------------------------------------ */
/* The fresh in-lock gate read and evaluator                           */
/* ------------------------------------------------------------------ */

export type NftGateRead = {
  token:
    | { kind: "missing" }
    | { kind: "unreadable" }
    | { kind: "read"; program: TokenProgram; owner: string; mint: string; amount: string; frozen: boolean; lamports: number };
  metadata:
    | { kind: "missing" }
    | { kind: "read"; mint: string; name: string | null; collectionVerified: boolean; collectionKey: string | null; lamports: number; dataLen: number; returnLamports: number };
  edition:
    | { kind: "missing" }
    | { kind: "unreadable" }
    | { kind: "read"; key: number; supply: string | null; lamports: number };
};

/** The action read: ONE batched getMultipleAccountsInfo over the
 *  token account, metadata PDA, and edition PDA at "confirmed" - the
 *  commitment the confirmation waits at, the same single-read
 *  discipline as unwrapNative's gate (audit L6) - plus the CURRENT
 *  rent-exempt minimum for the metadata's data length, which the
 *  on-chain close uses as its return figure (see
 *  close_program_account). Throws on RPC failure; the hook decides
 *  how to report it. */
export async function readNftGateState(
  connection: {
    getMultipleAccountsInfo: (
      keys: PublicKey[],
      config?: Commitment | GetMultipleAccountsConfig
    ) => Promise<Array<{ owner: PublicKey; lamports: number; data: Uint8Array } | null>>;
    getMinimumBalanceForRentExemption: (
      dataLen: number
    ) => Promise<number>;
  },
  candidate: { mint: string; pubkey: string }
): Promise<NftGateRead> {
  const mint = new PublicKey(candidate.mint);
  const [token, metadata, edition] = await connection.getMultipleAccountsInfo(
    [
      new PublicKey(candidate.pubkey),
      findMetadataPda(mint),
      findMasterEditionPda(mint),
    ],
    { commitment: "confirmed" }
  );

  let tokenRead: NftGateRead["token"] = { kind: "missing" };
  if (token) {
    const program: TokenProgram | null = token.owner.equals(TOKEN_PROGRAM_ID)
      ? "spl"
      : token.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? "token-2022"
        : null;
    const base = program === null ? null : parseClassicTokenAccount(token.data);
    tokenRead =
      program && base
        ? {
            kind: "read",
            program,
            owner: base.owner,
            mint: base.mint,
            amount: base.amount,
            frozen: base.frozen,
            lamports: token.lamports,
          }
        : // An account sits here but is not a readable token account:
          // distinct from provably-gone, and the gate aborts on it.
          { kind: "unreadable" };
  }

  let metadataRead: NftGateRead["metadata"] = { kind: "missing" };
  if (metadata) {
    const body = parseNftMetadata(metadata.data);
    if (body) {
      // The close's return figure: today's rent-exempt minimum for the
      // metadata's data length, capped at the balance. One extra cheap
      // read, the same figure the on-chain close itself computes.
      const rentExempt = await connection.getMinimumBalanceForRentExemption(
        metadata.data.length
      );
      metadataRead = {
        kind: "read",
        mint: body.mint,
        name: body.name,
        collectionVerified: body.collectionVerified,
        collectionKey: body.collectionKey,
        lamports: metadata.lamports,
        dataLen: metadata.data.length,
        returnLamports: metadataReturnLamports(
          metadata.lamports,
          metadata.data.length,
          rentExempt
        ),
      };
    } else if (isMetadataFeeHusk(metadata.data)) {
      // The closed-with-fee husk: not the reviewed metadata in any
      // usable sense, and the burn flow treats it as closed.
      metadataRead = { kind: "missing" };
    } else {
      metadataRead = { kind: "missing" };
    }
  }

  let editionRead: NftGateRead["edition"] = { kind: "missing" };
  if (edition) {
    const body = parseNftEdition(edition.data);
    editionRead = body
      ? { kind: "read", key: body.key, supply: body.supply, lamports: edition.lamports }
      : { kind: "unreadable" };
  }

  return { token: tokenRead, metadata: metadataRead, edition: editionRead };
}

/** What the on-chain close returns for a metadata account:
 *  close_program_account moves exactly Rent::minimum_balance(dataLen)
 *  to the destination and leaves any excess in a one-byte husk (the
 *  metadata's stored Metaplex create fee, claimable only through
 *  Metaplex's own ownerless path). Capped at the balance: a metadata
 *  account holding less than today's minimum (grandfathered below it)
 *  returns what it holds. DEVNET-VERIFIED 2026-11-13: a fee-era
 *  metadata closed to a 1-byte zero-key husk with the fee inside. */
export function metadataReturnLamports(
  lamports: number,
  dataLen: number,
  rentExempt: number
): number {
  return Math.min(lamports, rentExempt);
}

/** The closed-with-fee husk shape the on-chain close leaves behind
 *  when a metadata account holds more than its rent-exempt minimum:
 *  one byte, set to 0 (Key::Uninitialized). The verification reads
 *  this as the closed shape - the burn succeeded and the account's
 *  recoverable rent left for the wallet. */
export function isMetadataFeeHusk(data: Uint8Array): boolean {
  return data.length === 1 && data[0] === KEY_UNINITIALIZED;
}

export type NftGateAbortReason =
  | "unreadable"
  | "foreign-owner"
  | "foreign-program"
  | "frozen"
  | "mint-mismatch"
  | "metadata-missing"
  | "not-master-edition"
  | "has-prints"
  | "wrong-amount";

export type NftGateVerdict =
  | {
      kind: "pass";
      /** The three pre-balances the fee's 1% comes off (memo section
       *  1.3: one fee base number, the sum, to buildFeeTransfer). */
      tokenLamports: number;
      metadataLamports: number;
      editionLamports: number;
      /** What the metadata close actually returns: today's rent-exempt
       *  minimum for its data length, capped at the balance (the
       *  stored Metaplex create fee, when one exists, stays in the
       *  one-byte husk). Equal to metadataLamports for every
       *  metadata priced exactly at today's minimum - the whole
       *  current cohort. */
      metadataReturnLamports: number;
      collectionVerified: boolean;
      collectionKey: string | null;
      name: string | null;
    }
  | { kind: "already-gone" }
  | { kind: "metadata-only" }
  | { kind: "abort"; reason: NftGateAbortReason };

/**
 * Compare one on-chain gate read against the reviewed candidate,
 * pre-checking every assertion the on-chain BurnNft enforces
 * (memo section 1.1 N1-N7), in the program's own order where they
 * overlap. Rent drift vs the scan is NOT an abort (the Case B policy
 * shared with the dust flow): the current figures travel to the card.
 * A zero amount with the account still open is the already-burned
 * shape (the §3.5 fixture 3: the plain SPL burn left metadata and
 * edition alive behind a dead token) and reports the already-gone
 * terminal with the stranded-rent truth.
 */
export function evaluateNftGate(
  read: NftGateRead,
  reviewedMint: string,
  connectedOwner: string
): NftGateVerdict {
  if (read.token.kind === "unreadable") {
    return { kind: "abort", reason: "unreadable" };
  }
  if (read.token.kind !== "read") {
    // Missing token account: gone, whether closed or plain-burned.
    return { kind: "already-gone" };
  }
  const t = read.token;
  if (t.program !== "spl") {
    return { kind: "abort", reason: "foreign-program" };
  }
  if (t.owner !== connectedOwner) {
    return { kind: "abort", reason: "foreign-owner" };
  }
  if (t.frozen) {
    return { kind: "abort", reason: "frozen" };
  }
  if (t.mint !== reviewedMint) {
    return { kind: "abort", reason: "mint-mismatch" };
  }
  if (t.amount === "0") {
    return { kind: "already-gone" };
  }
  if (t.amount !== "1") {
    return { kind: "abort", reason: "wrong-amount" };
  }
  if (read.metadata.kind !== "read") {
    return { kind: "abort", reason: "metadata-missing" };
  }
  const m = read.metadata;
  if (m.mint !== reviewedMint) {
    return { kind: "abort", reason: "mint-mismatch" };
  }
  if (read.edition.kind === "unreadable") {
    return { kind: "abort", reason: "unreadable" };
  }
  if (read.edition.kind === "missing") {
    return { kind: "metadata-only" };
  }
  const e = read.edition;
  if (e.key !== MASTER_EDITION_KEY_V2 && e.key !== MASTER_EDITION_KEY_V1) {
    return { kind: "abort", reason: "not-master-edition" };
  }
  if (e.supply !== null && BigInt(e.supply) > 0n) {
    return { kind: "abort", reason: "has-prints" };
  }
  return {
    kind: "pass",
    tokenLamports: t.lamports,
    metadataLamports: m.lamports,
    metadataReturnLamports: m.returnLamports,
    editionLamports: e.lamports,
    collectionVerified: m.collectionVerified,
    collectionKey: m.collectionKey,
    name: m.name,
  };
}

/* ------------------------------------------------------------------ */
/* The hand-built BurnNft instruction (memo section 3.1)               */
/* ------------------------------------------------------------------ */

export interface BurnNftBuildEvidence {
  mint: string;
  tokenPubkey: string;
  /** The verified collection's mint, when the gate read a verified
   *  collection field. The collection metadata PDA derives from it;
   *  the correct PDA is always the right account to pass (memo N4: an
   *  empty or burned collection account at the correct PDA is
   *  accepted by the program). */
  collectionKey: string | null;
}

/**
 * Build THE BurnNft instruction for one reviewed candidate: tag 29,
 * one data byte, keys in the wire order (metadata PDA writable; owner
 * writable signer; mint writable; token account writable; master
 * edition PDA writable; SPL token program readonly; collection
 * metadata PDA writable, only when a verified collection exists).
 * The fee transfer is appended by the hook with the three pre-balances
 * as the fee base - never part of this builder. Nothing else, ever: no
 * transfer, no approve, no compute-budget instruction of the app's
 * own.
 */
export function buildBurnNftInstruction(
  evidence: BurnNftBuildEvidence,
  owner: PublicKey
): TransactionInstruction {
  const mint = new PublicKey(evidence.mint);
  const keys: TransactionInstruction["keys"] = [
    { pubkey: findMetadataPda(mint), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(evidence.tokenPubkey), isSigner: false, isWritable: true },
    { pubkey: findMasterEditionPda(mint), isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  if (evidence.collectionKey !== null) {
    keys.push({
      pubkey: findMetadataPda(new PublicKey(evidence.collectionKey)),
      isSigner: false,
      isWritable: true,
    });
  }
  return new TransactionInstruction({
    programId: METAPLEX_TOKEN_METADATA_PROGRAM_ID,
    keys,
    data: Buffer.from([BURN_NFT_TAG]),
  });
}

/* ------------------------------------------------------------------ */
/* Copy (the memo section 1.5 sentences, test-pinned)                  */
/* ------------------------------------------------------------------ */

/** User-facing sentences for the gate aborts. Shared so the hook's
 *  error line and the card's abort note say the same thing. */
export const BURN_NFT_GATE_ABORT_COPY: Record<NftGateAbortReason, string> = {
  unreadable:
    "The current account state could not be read. Nothing was signed.",
  "foreign-owner":
    "This token account is no longer owned by the connected wallet. Nothing was signed.",
  "foreign-program":
    "This token account is owned by the Token-2022 program, and the burn instruction this version offers runs on the SPL Token Program only. Nothing was signed.",
  frozen:
    "The fresh read reports this NFT\u2019s account as frozen, and a frozen account cannot be burned. Only the mint\u2019s freeze authority can unfreeze it. Nothing was signed.",
  "mint-mismatch":
    "The fresh read shows a different mint on this account than the scan recorded. Nothing was signed.",
  "metadata-missing":
    "The fresh read shows no metadata account behind this NFT, so the network would refuse the burn. Nothing was signed.",
  "not-master-edition":
    "The fresh read shows something other than a master edition at this NFT\u2019s edition address, so the network would refuse the burn. Nothing was signed.",
  "has-prints":
    "The master edition behind this NFT still has print editions outstanding, and the network refuses to burn it until none remain. Nothing was signed.",
  "wrong-amount":
    "This account no longer holds exactly one token, so it no longer matches what you reviewed. Nothing was signed. Start a fresh review to see the current state.",
};

/** Terminal sentence for the already-gone shape: a missing token
 *  account, or a zero balance where the plain burn left the metadata
 *  and edition stranded behind it (the §3.5 fixture 3 truth). */
export const NFT_ALREADY_GONE_COPY =
  "This NFT\u2019s token account no longer exists. If it was burned through the plain token burn, its metadata and edition rent is stranded permanently; no one can claim it. Nothing was signed.";

/** Terminal sentence for the metadata-only shape (N7). */
export const NFT_METADATA_ONLY_COPY =
  "No edition account exists behind this token, so there is no NFT burn. The token account itself can still be closed through the dust burn; the metadata deposit is unreachable by anyone, including this tool. Nothing was signed.";

/** The consent card's fixed sentences (the memo section 1.5 draft). */
export const NFT_BURN_CARD_PERMANENCE =
  "Burning is permanent. The NFT cannot be un-burned, the accounts disappear from the chain, and no one can restore them. SOL.REPAIR cannot judge what an NFT is worth, and burning is not undoable.";
export const NFT_BURN_CARD_COLLECTION =
  "This NFT belongs to a verified collection. Burning it reduces that collection\u2019s on-chain size by one.";
export const NFT_BURN_CARD_STRANDING =
  "This burn also closes the metadata and edition rent. Closing the account through the plain token burn instead strands that rent permanently: no instruction can reach it once the token is gone.";

/** The consent card's intro with the three-account deposit figure. */
export const nftBurnCardIntro = (rentSol: string): string =>
  `This sends one instruction (Metaplex BurnNft). It burns this NFT\u2019s single token, then closes three accounts: the token account, the metadata account, and the master edition account. All three deposits, ${rentSol} SOL, return to your wallet.`;

/** The fee-era intro variant: when the metadata holds more than its
 *  rent-exempt minimum (a stored Metaplex create fee), only the rent
 *  returns and the fee stays in the husk. Used when the return figure
 *  differs from the deposit total; the plain intro is exact otherwise. */
export const nftBurnCardIntroFeeEra = (
  returnSol: string,
  depositSol: string
): string =>
  `This sends one instruction (Metaplex BurnNft). It burns this NFT\u2019s single token, then closes three accounts: the token account, the metadata account, and the master edition account. The three accounts\u2019 rent, ${returnSol} SOL, returns to your wallet. The three deposits hold ${depositSol} SOL in total; the metadata account carries a stored Metaplex create fee which stays in a one-byte husk that only Metaplex can claim.`;

/** The consent card's fee line with the exact figures (memo section
 *  1.3 card wording). Exact when the deposits equal what the closes
 *  return (the whole current cohort); the fee-era variant below states
 *  the deposit base when a stored fee makes them differ. */
export const nftBurnCardFeeLine = (
  feeLamports: string,
  rentLamports: string
): string =>
  `The fee is 1 percent of the SOL these closes return, floored to whole lamports: ${feeLamports} lamports of ${rentLamports} lamports. It is a plain transfer in the same transaction, visible before you approve, charged only if the transaction succeeds. Burning the token itself destroys it and is charged nothing.`;

/** The fee-era fee line: the ruling's base is the three deposits'
 *  pre-balances (memo section 1.3), stated as such when a stored fee
 *  makes the deposits differ from what the closes return. */
export const nftBurnCardFeeLineFeeEra = (
  feeLamports: string,
  depositLamports: string
): string =>
  `The fee is 1 percent of the three deposits, floored to whole lamports: ${feeLamports} lamports of ${depositLamports} lamports. It is a plain transfer in the same transaction, visible before you approve, charged only if the transaction succeeds. Burning the token itself destroys it and is charged nothing.`;

/** The scan row's summary (memo section 1.5 row label). */
export const nftRowSummary = (rentSol: string, feeSol: string): string =>
  `burns this NFT (1 token) and closes its token, metadata, and master edition accounts. Recovers ${rentSol} SOL. Fee 1% = ${feeSol} SOL.`;

/** Honest scan-row sentences for the classes v1 does not offer. */
export const NFT_FROZEN_ROW_COPY = BURN_NFT_GATE_ABORT_COPY.frozen;
export const NFT_HAS_PRINTS_ROW_COPY = BURN_NFT_GATE_ABORT_COPY["has-prints"];
export const NFT_PRINT_EDITION_ROW_COPY =
  "This NFT\u2019s edition account holds a print edition, not a master edition, and the burn instruction this version offers does not cover prints. Nothing is offered here. Burning it through the plain dust burn would strand the edition deposit permanently.";
export const NFT_MASTER_V1_ROW_COPY =
  "This NFT\u2019s edition account holds a MasterEditionV1. This version routes only MasterEditionV2 NFTs, so nothing is offered here.";
export const NFT_TOKEN22_ROW_COPY = BURN_NFT_GATE_ABORT_COPY["foreign-program"];
