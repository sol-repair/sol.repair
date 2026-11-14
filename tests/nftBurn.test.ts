/**
 * Tests for the dead-NFT burn-and-close lib
 * (docs/dead-nft-scope-memo-2026-11.md, the v1 slice the owner approved
 * 2026-11-13): PDA derivation against real chain vectors, the metadata
 * / edition / token / mint raw parsers against REAL mainnet account
 * bytes captured by the exploration thread, the scan selection, the
 * classification truth table, the gate evaluator, the hand-built
 * BurnNft wire, and the copy constants.
 *
 * Wire facts are source-verified (sources saved by the exploration
 * thread in .verify-tmp/dead-nft-scope/sources/): BurnNft is tag 29 on
 * metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s, single data byte, keys
 * metadata/owner/mint/token/masterEdition/splToken (+optional
 * collection metadata); MasterEditionV2 key byte 6, supply at bytes
 * 1..9 (nonfungible.rs array_ref![data, 1, 8]); the metadata account
 * is borsh with collection after token_standard.
 */

import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  BURN_NFT_TAG,
  BURN_NFT_GATE_ABORT_COPY,
  EDITION_KEY_V1,
  MASTER_EDITION_KEY_V1,
  MASTER_EDITION_KEY_V2,
  METADATA_KEY_V1,
  METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  NFT_ALREADY_GONE_COPY,
  NFT_BURN_CARD_COLLECTION,
  NFT_BURN_CARD_PERMANENCE,
  NFT_BURN_CARD_STRANDING,
  isMetadataFeeHusk,
  metadataReturnLamports,
  nftBurnCardIntroFeeEra,
  NFT_METADATA_ONLY_COPY,
  buildBurnNftInstruction,
  classifyNftCandidate,
  evaluateNftGate,
  findMasterEditionPda,
  findMetadataPda,
  parseClassicTokenAccount,
  parseMintBase,
  parseNftEdition,
  parseNftMetadata,
  selectNftScanCandidates,
} from "../src/lib/solana/nftBurn";
import type { NftGateRead } from "../src/lib/solana/nftBurn";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type ScanResult,
  type SkippedAccount,
} from "../src/lib/solana/tokenAccounts";

const OWNER = Keypair.generate();
const OWNER_B58 = OWNER.publicKey.toBase58();

/* ------------------------------------------------------------------ */
/* Real chain fixtures, captured 2026-11-13 by the exploration thread  */
/* ------------------------------------------------------------------ */

// Saga Pass: a real mainnet metadata account (607 bytes), mint
// 3vPfZ5tGVD5fuqgje5iTwoJ1nUaXWmbanYSTWbr2UBSM, verified collection
// saga8uJYtWyHZ7spe4RVUA5eutbZPQYZe6D9uCkVK6r. Its metadata PDA and
// master edition PDA are pinned below and re-derived here every run.
const SAGA_MINT = "3vPfZ5tGVD5fuqgje5iTwoJ1nUaXWmbanYSTWbr2UBSM";
const SAGA_METADATA_PDA = "7Z2yDoU5erdqxM5fFotZkXYoRX5fb8MA6V4x7jBTcBxr";
const SAGA_EDITION_PDA = "4UNzDGzKFAA35ShiZekiBs7tdhdkerwmM4xSNHtykd9W";
const SAGA_COLLECTION_MINT = "saga8uJYtWyHZ7spe4RVUA5eutbZPQYZe6D9uCkVK6r";
const SAGA_METADATA_B64 =
  "BAz75CwWw4dFlKyywwXOAGu9FG5rekybb7T01Hb88vcPK2TIp06QMJw57RUAKIheXnWSsXEq27htzbNOjkoeOQ4gAAAAU2FnYSBQYXNzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAAAAUjIAAAAAAAAAAMgAAABodHRwczovL2Fyd2VhdmUubmV0LzZqUm9aLUFaRU9GTmhyejJYVkpaTTRGWkxQWXpFcTFGdWoxdUpoYW9xWUEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAM++QsFsOHRZSsssMFzgBrvRRua3pMm2+09NR2/PL3DwFkAAEB/wEAAQEM9SAHSEnTjvcTLOOT9fqX7mzl1GQ2s7RYdHzFdXE0ywECAQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

// The Pond of Dreams: a real mainnet metadata account with NO
// collection field, mint 6oStubZ7nmxcuexiBVMMQyfdL89NR8jXAP1cModLD6S6.
const POND_METADATA_B64 =
  "BOZhxKb+KGOv5v/56dmBoSrGFwUxlO8csA3sEL/qWV44VjBubWu+lMlNZnsM0CJFKG2hDIfJhrsSOI+D4ChF+HMgAAAAVGhlIFBvbmQgb2YgRHJlYW1zAAAAAAAAAAAAAAAAAAAKAAAAVFBPRAAAAAAAAMgAAABodHRwczovL2JhZnliZWllcHdyZDNxbmY0NHIzbnNnbWYzaXRkNXB4ZWFvaXV4YW1qYnNwZHFmdGlwcmhsNTRobTV5LmlwZnMubmZ0c3RvcmFnZS5saW5rLzAuanNvbgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOgDAQMAAAACEIKLFdBCTKwQ8hzhrYQ2wIEdi1TvaTCUSu7/omyQqAEAjawQEI6lnTXoxd7At0d/HhWSIlw24S+AIoIXMue6pP4AMozZDY51MAsSRBtPwNaDe/LV/f82SfWRsXDdeL6UQvvxADIBAQH/AQQAAAABAAGCChIGKrWGX2pQgqhem+24MXb/UYGRGeNl3dNk4CMxmgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

// A real mainnet MasterEditionV2 account body: key 6, supply 0,
// then the 11 trailing bytes the census read captured (the program
// itself reads the supply at bytes 1..9, nonfungible.rs
// array_ref![edition_account_data, 1, 8]).
const SAGA_EDITION_B64 = "BgAAAAAAAAAAAQAAAAAAAAAAAAQ=";

/* ------------------------------------------------------------------ */
/* PDA derivation                                                      */
/* ------------------------------------------------------------------ */

describe("nftBurn PDA derivation (real chain vectors)", () => {
  it("derives the Saga Pass metadata PDA exactly as the chain holds it", async () => {
    const derived = findMetadataPda(new PublicKey(SAGA_MINT));
    expect(derived.toBase58()).toBe(SAGA_METADATA_PDA);
  });

  it("derives the Saga Pass master edition PDA exactly as the chain holds it", async () => {
    const derived = findMasterEditionPda(new PublicKey(SAGA_MINT));
    expect(derived.toBase58()).toBe(SAGA_EDITION_PDA);
  });
});

/* ------------------------------------------------------------------ */
/* The metadata parser against real account bytes                      */
/* ------------------------------------------------------------------ */

describe("parseNftMetadata (real mainnet bytes)", () => {
  it("reads the Saga Pass account: mint, name, verified collection", () => {
    const parsed = parseNftMetadata(Buffer.from(SAGA_METADATA_B64, "base64"));
    expect(parsed).not.toBeNull();
    expect(parsed!.mint).toBe(SAGA_MINT);
    expect(parsed!.name).toBe("Saga Pass");
    expect(parsed!.collectionVerified).toBe(true);
    expect(parsed!.collectionKey).toBe(SAGA_COLLECTION_MINT);
  });

  it("reads the Pond of Dreams account: no collection field", () => {
    const parsed = parseNftMetadata(Buffer.from(POND_METADATA_B64, "base64"));
    expect(parsed).not.toBeNull();
    expect(parsed!.mint).toBe("6oStubZ7nmxcuexiBVMMQyfdL89NR8jXAP1cModLD6S6");
    expect(parsed!.name).toBe("The Pond of Dreams");
    expect(parsed!.collectionVerified).toBe(false);
    expect(parsed!.collectionKey).toBeNull();
  });

  it("returns null for data truncated inside a decision-relevant field", () => {
    const full = Buffer.from(SAGA_METADATA_B64, "base64");
    // Cuts before or inside the mint, the name, the uri, the creators,
    // or the collection field all leave a decision byte unreadable:
    // null, never a guess. (A cut after the collection field - the
    // trailing uses/options - keeps every decision-relevant byte and
    // still parses, which is correct: the burn flow reads nothing past
    // the collection.)
    for (const cut of [0, 65, 100, 200, 320, 360, 365, 366, 370]) {
      expect(parseNftMetadata(full.subarray(0, cut))).toBeNull();
    }
    expect(
      parseNftMetadata(full.subarray(0, full.length - 1))
    ).not.toBeNull();
  });

  it("returns null when the key byte is not a metadata account", () => {
    const full = Buffer.from(SAGA_METADATA_B64, "base64");
    const wrong = Buffer.from(full);
    wrong[0] = MASTER_EDITION_KEY_V2;
    expect(parseNftMetadata(wrong)).toBeNull();
    wrong[0] = 0;
    expect(parseNftMetadata(wrong)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The edition parser                                                  */
/* ------------------------------------------------------------------ */

describe("parseNftEdition", () => {
  it("reads a real MasterEditionV2: key 6, supply 0", () => {
    const parsed = parseNftEdition(Buffer.from(SAGA_EDITION_B64, "base64"));
    expect(parsed).not.toBeNull();
    expect(parsed!.key).toBe(MASTER_EDITION_KEY_V2);
    expect(parsed!.supply).toBe("0");
  });

  it("reads a supply with prints outstanding (synthetic, the N2 shape)", () => {
    const data = Buffer.alloc(20);
    data[0] = MASTER_EDITION_KEY_V2;
    data.writeBigUInt64LE(3n, 1);
    const parsed = parseNftEdition(data);
    expect(parsed).toEqual({ key: MASTER_EDITION_KEY_V2, supply: "3" });
  });

  it("reads a print edition account (key 1, the N6 shape)", () => {
    // EditionV1: key, parent offset u64, parent data offset u32, slot u64.
    const data = Buffer.alloc(57);
    data[0] = EDITION_KEY_V1;
    const parsed = parseNftEdition(data);
    expect(parsed).toEqual({ key: EDITION_KEY_V1, supply: null });
  });

  it("reads a MasterEditionV1 (key 2) with its supply", () => {
    const data = Buffer.alloc(20);
    data[0] = MASTER_EDITION_KEY_V1;
    data.writeBigUInt64LE(1n, 1);
    const parsed = parseNftEdition(data);
    expect(parsed).toEqual({ key: MASTER_EDITION_KEY_V1, supply: "1" });
  });

  it("returns null for data too short to hold the supply", () => {
    expect(parseNftEdition(Buffer.alloc(0))).toBeNull();
    expect(parseNftEdition(Buffer.alloc(8))).toBeNull();
    // 9 bytes: key + full supply, the minimum the burn flow reads.
    const min = Buffer.alloc(9);
    min[0] = MASTER_EDITION_KEY_V2;
    expect(parseNftEdition(min)).toEqual({
      key: MASTER_EDITION_KEY_V2,
      supply: "0",
    });
  });
});

/* ------------------------------------------------------------------ */
/* The token account and mint base parsers                             */
/* ------------------------------------------------------------------ */

describe("parseClassicTokenAccount", () => {
  function tokenAccountData(opts: {
    mint?: PublicKey;
    owner?: PublicKey;
    amount?: bigint;
    frozen?: boolean;
  }): Buffer {
    const data = Buffer.alloc(165);
    Buffer.from(
      (opts.mint ?? Keypair.generate().publicKey).toBuffer()
    ).copy(data, 0);
    Buffer.from((opts.owner ?? OWNER.publicKey).toBuffer()).copy(data, 32);
    data.writeBigUInt64LE(opts.amount ?? 1n, 64);
    // state at byte 108: 1 initialized, 2 frozen
    data[108] = opts.frozen ? 2 : 1;
    return data;
  }

  it("reads mint, owner, amount, and unfrozen state", () => {
    const mint = Keypair.generate().publicKey;
    const parsed = parseClassicTokenAccount(tokenAccountData({ mint }));
    expect(parsed).not.toBeNull();
    expect(parsed!.mint).toBe(mint.toBase58());
    expect(parsed!.owner).toBe(OWNER_B58);
    expect(parsed!.amount).toBe("1");
    expect(parsed!.frozen).toBe(false);
  });

  it("reads the frozen state (byte 108 = 2)", () => {
    const parsed = parseClassicTokenAccount(tokenAccountData({ frozen: true }));
    expect(parsed!.frozen).toBe(true);
  });

  it("reads a zero amount (the plain-burned shape)", () => {
    const parsed = parseClassicTokenAccount(tokenAccountData({ amount: 0n }));
    expect(parsed!.amount).toBe("0");
  });

  it("returns null for data shorter than the 165-byte base layout", () => {
    expect(parseClassicTokenAccount(Buffer.alloc(164))).toBeNull();
    expect(parseClassicTokenAccount(Buffer.alloc(0))).toBeNull();
  });
});

describe("parseMintBase", () => {
  function mintData(opts: { supply?: bigint; decimals?: number } = {}): Buffer {
    const data = Buffer.alloc(82);
    // authority COption none (4 zero bytes), supply u64 at 36, decimals at 44
    data.writeBigUInt64LE(opts.supply ?? 1n, 36);
    data[44] = opts.decimals ?? 0;
    data[45] = 1; // is_initialized
    return data;
  }

  it("reads a classic mint: supply 1, decimals 0", () => {
    expect(parseMintBase(mintData())).toEqual({ decimals: 0, supply: "1" });
  });

  it("reads a fungible decimals-0 mint: supply above 1", () => {
    expect(parseMintBase(mintData({ supply: 999n }))).toEqual({
      decimals: 0,
      supply: "999",
    });
  });

  it("reads a Token-2022 mint's base layout (extensions append after byte 82)", () => {
    // Base 82 bytes + trailing TLV extension bytes; the base fields the
    // parser reads are a prefix, so the parse must not care about the
    // extension bytes.
    const extended = Buffer.concat([mintData(), Buffer.alloc(120, 7)]);
    expect(parseMintBase(extended)).toEqual({ decimals: 0, supply: "1" });
  });

  it("returns null for uninitialized or short data", () => {
    expect(parseMintBase(Buffer.alloc(81))).toBeNull();
    const empty = Buffer.alloc(82);
    empty[45] = 0; // not initialized
    expect(parseMintBase(empty)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Selection from the scan                                             */
/* ------------------------------------------------------------------ */

function fundedEntry(over: Partial<SkippedAccount> = {}): SkippedAccount {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    reason: "holds a token balance",
    program: "spl",
    cause: "funded",
    balance: "1",
    decimals: 0,
    lamports: 2039280,
    nativeStatus: "non-native",
    ...over,
  };
}

function scanWith(entries: SkippedAccount[]): ScanResult {
  return {
    totalAccounts: entries.length,
    eligibleAccounts: [],
    recoverableLamports: 0n,
    skippedAccounts: entries,
  };
}

describe("selectNftScanCandidates", () => {
  it("selects a classic funded decimals-0 account with complete evidence", () => {
    const out = selectNftScanCandidates(scanWith([fundedEntry()]));
    expect(out).toHaveLength(1);
    expect(out[0].amountAtScan).toBe("1");
    expect(out[0].lamports).toBe(2039280);
  });

  it("includes frozen candidates (honest disclosure rows, no offer)", () => {
    const out = selectNftScanCandidates(
      scanWith([fundedEntry({ frozen: true })])
    );
    expect(out).toHaveLength(1);
  });

  it("selects Token-2022 decimals-0 candidates (honest rows only)", () => {
    const out = selectNftScanCandidates(
      scanWith([fundedEntry({ program: "token-2022" })])
    );
    expect(out).toHaveLength(1);
  });

  it("excludes decimals above 0 (fungible tokens are not NFT candidates)", () => {
    expect(
      selectNftScanCandidates(scanWith([fundedEntry({ decimals: 6 })]))
    ).toHaveLength(0);
  });

  it("excludes entries with incomplete evidence (never invented)", () => {
    expect(
      selectNftScanCandidates(scanWith([fundedEntry({ lamports: undefined })]))
    ).toHaveLength(0);
    expect(
      selectNftScanCandidates(scanWith([fundedEntry({ decimals: undefined })]))
    ).toHaveLength(0);
    expect(
      selectNftScanCandidates(scanWith([fundedEntry({ balance: "0" })]))
    ).toHaveLength(0);
  });

  it("excludes a foreign close authority (no burn could succeed)", () => {
    expect(
      selectNftScanCandidates(
        scanWith([fundedEntry({ foreignCloseAuthority: true })])
      )
    ).toHaveLength(0);
  });

  it("excludes non-funded entries", () => {
    const wrapped: SkippedAccount = {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      reason: "is a wrapped-SOL account",
      program: "spl",
      cause: "wrapped-sol",
      lamports: 15239280,
      nativeStatus: "native",
    };
    expect(selectNftScanCandidates(scanWith([wrapped]))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

describe("classifyNftCandidate (the routing truth table)", () => {
  const candidate = {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: SAGA_MINT,
    program: "spl" as const,
    lamports: 2039280,
    amountAtScan: "1",
  };

  const mintRead = (over: Record<string, unknown> = {}) => ({
    status: "read" as const,
    decimals: 0,
    supply: "1",
    program: "spl" as const,
    ...over,
  });
  const tokenRead = (over: Record<string, unknown> = {}) => ({
    kind: "read" as const,
    program: "spl" as const,
    lamports: 2039280,
    base: {
      mint: SAGA_MINT,
      owner: OWNER_B58,
      amount: "1",
      frozen: false,
      ...over,
    },
  });
  const metadataRead = (over: Record<string, unknown> = {}) => ({
    kind: "read" as const,
    lamports: 3733800,
    body: {
      mint: SAGA_MINT,
      name: "Saga Pass",
      collectionVerified: true,
      collectionKey: SAGA_COLLECTION_MINT,
      ...over,
    },
  });
  const editionRead = (over: Record<string, unknown> = {}) => ({
    kind: "read" as const,
    lamports: 1030080,
    body: {
      key: MASTER_EDITION_KEY_V2,
      supply: "0",
      ...over,
    },
  });

  it("routes a classic master-edition-backed NFT to the burnable class", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead(),
      tokenRead(),
      metadataRead(),
      editionRead()
    );
    expect(verdict.class).toBe("burnable");
    expect(verdict.collectionVerified).toBe(true);
    expect(verdict.rentLamports).toBe(2039280 + 3733800 + 1030080);
  });

  it("routes a mint with decimals above 0 to not-nft (today's dust flow)", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead({ decimals: 2 }),
      tokenRead(),
      metadataRead(),
      editionRead()
    );
    expect(verdict.class).toBe("not-nft");
  });

  it("routes a supply-above-1 mint to not-nft (the fungible decimals-0 class)", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead({ supply: "999" }),
      tokenRead(),
      metadataRead(),
      editionRead()
    );
    expect(verdict.class).toBe("not-nft");
  });

  it("routes a missing mint to not-nft, never to an offer", () => {
    const verdict = classifyNftCandidate(
      candidate,
      { status: "missing" },
      tokenRead(),
      metadataRead(),
      editionRead()
    );
    expect(verdict.class).toBe("not-nft");
  });

  it("routes an unreadable mint to not-nft (fail toward not promising)", () => {
    const verdict = classifyNftCandidate(
      candidate,
      { status: "unreadable" },
      tokenRead(),
      metadataRead(),
      editionRead()
    );
    expect(verdict.class).toBe("not-nft");
  });

  it("routes a missing edition PDA to metadata-only (the N7 terminal)", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead(),
      tokenRead(),
      metadataRead(),
      { kind: "missing" }
    );
    expect(verdict.class).toBe("metadata-only");
    expect(verdict.rentLamports).toBe(2039280 + 3733800);
  });

  it("routes a print edition (key 1) to the print-edition class", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead(),
      tokenRead(),
      metadataRead(),
      editionRead({ key: EDITION_KEY_V1, supply: null })
    );
    expect(verdict.class).toBe("print-edition");
  });

  it("routes a MasterEditionV1 (key 2) to the master-v1 class", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead(),
      tokenRead(),
      metadataRead(),
      editionRead({ key: MASTER_EDITION_KEY_V1, supply: "0" })
    );
    expect(verdict.class).toBe("master-v1");
  });

  it("routes a master edition with prints to has-prints (the N2 row)", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead(),
      tokenRead(),
      metadataRead(),
      editionRead({ supply: "2" })
    );
    expect(verdict.class).toBe("has-prints");
  });

  it("routes a frozen master-backed NFT to the frozen class (the N1 row)", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead(),
      tokenRead({ frozen: true }),
      metadataRead(),
      editionRead()
    );
    expect(verdict.class).toBe("frozen");
  });

  it("routes a Token-2022 NFT to the token22 class (the N5 row)", () => {
    const verdict = classifyNftCandidate(
      { ...candidate, program: "token-2022" as const },
      mintRead({ program: "token-2022" }),
      {
        kind: "read",
        program: "token-2022" as const,
        lamports: 2039280,
        base: {
          mint: SAGA_MINT,
          owner: OWNER_B58,
          amount: "1",
          frozen: false,
        },
      },
      metadataRead(),
      editionRead()
    );
    expect(verdict.class).toBe("token22");
  });

  it("routes a token account whose mint mismatches to not-nft", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead(),
      tokenRead({ mint: Keypair.generate().publicKey.toBase58() }),
      metadataRead(),
      editionRead()
    );
    expect(verdict.class).toBe("not-nft");
  });

  it("routes a token holding more than 1 unit to not-nft", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead(),
      tokenRead({ amount: "3" }),
      metadataRead(),
      editionRead()
    );
    expect(verdict.class).toBe("not-nft");
  });

  it("routes a missing token account to not-nft (nothing to offer)", () => {
    const verdict = classifyNftCandidate(
      candidate,
      mintRead(),
      { kind: "missing" },
      metadataRead(),
      editionRead()
    );
    expect(verdict.class).toBe("not-nft");
  });
});

/* ------------------------------------------------------------------ */
/* The gate evaluator                                                  */
/* ------------------------------------------------------------------ */

function gateRead(over: {
  token?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  edition?: Record<string, unknown>;
}): NftGateRead {
  return {
    token: {
      kind: "read",
      program: "spl",
      owner: OWNER_B58,
      mint: SAGA_MINT,
      amount: "1",
      frozen: false,
      lamports: 2039280,
      ...over.token,
    } as NftGateRead["token"],
    metadata: {
      kind: "read",
      mint: SAGA_MINT,
      name: "Saga Pass",
      collectionVerified: false,
      collectionKey: null,
      lamports: 3733800,
      dataLen: 607,
      returnLamports: 3733800,
      ...over.metadata,
    } as NftGateRead["metadata"],
    edition: {
      kind: "read",
      key: MASTER_EDITION_KEY_V2,
      supply: "0",
      lamports: 1030080,
      ...over.edition,
    } as NftGateRead["edition"],
  };
}

describe("evaluateNftGate (the N1-N7 abort rows)", () => {
  const candidate = {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: SAGA_MINT,
    program: "spl" as const,
    lamports: 2039280,
    amountAtScan: "1",
  };

  it("passes a live master-backed NFT with the three lamports", () => {
    const verdict = evaluateNftGate(
      gateRead({
        metadata: { collectionVerified: true, collectionKey: SAGA_COLLECTION_MINT },
        edition: { supply: "0" },
      }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict.kind).toBe("pass");
    if (verdict.kind === "pass") {
      expect(verdict.tokenLamports).toBe(2039280);
      expect(verdict.metadataLamports).toBe(3733800);
      expect(verdict.metadataReturnLamports).toBe(3733800);
      expect(verdict.editionLamports).toBe(1030080);
      // The fee base ruling (owner word 2026-11-13): 1% of the ACTUAL
      // return, never of lamports the user does not receive.
      expect(verdict.returnLamports).toBe(6803160);
      expect(verdict.collectionVerified).toBe(true);
      expect(verdict.collectionKey).toBe(SAGA_COLLECTION_MINT);
    }
  });

  it("reports already-gone when the token account is missing", () => {
    const verdict = evaluateNftGate(
      gateRead({ token: { kind: "missing" } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict.kind).toBe("already-gone");
  });

  it("reports already-gone for a zero amount (the plain-burned shape)", () => {
    const verdict = evaluateNftGate(
      gateRead({ token: { amount: "0" } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict.kind).toBe("already-gone");
  });

  it("aborts on a token amount above 1 (never a false promise)", () => {
    const verdict = evaluateNftGate(
      gateRead({ token: { amount: "2" } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict).toEqual({ kind: "abort", reason: "wrong-amount" });
  });

  it("aborts on a foreign owner", () => {
    const verdict = evaluateNftGate(
      gateRead({ token: { owner: Keypair.generate().publicKey.toBase58() } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict).toEqual({ kind: "abort", reason: "foreign-owner" });
  });

  it("aborts on a Token-2022 token account (N5)", () => {
    const verdict = evaluateNftGate(
      gateRead({
        token: { program: "token-2022" },
      }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict).toEqual({ kind: "abort", reason: "foreign-program" });
  });

  it("aborts on a frozen token account (N1)", () => {
    const verdict = evaluateNftGate(
      gateRead({ token: { frozen: true } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict).toEqual({ kind: "abort", reason: "frozen" });
  });

  it("aborts on a mint mismatch", () => {
    const verdict = evaluateNftGate(
      gateRead({ token: { mint: Keypair.generate().publicKey.toBase58() } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict).toEqual({ kind: "abort", reason: "mint-mismatch" });
  });

  it("aborts when the metadata account is missing", () => {
    const verdict = evaluateNftGate(
      gateRead({ metadata: { kind: "missing" } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict).toEqual({ kind: "abort", reason: "metadata-missing" });
  });

  it("reports the metadata-only terminal when no edition exists (N7)", () => {
    const verdict = evaluateNftGate(
      gateRead({ edition: { kind: "missing" } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict.kind).toBe("metadata-only");
  });

  it("aborts on a print edition at the edition address (N6)", () => {
    const verdict = evaluateNftGate(
      gateRead({ edition: { key: EDITION_KEY_V1, supply: null } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict).toEqual({ kind: "abort", reason: "not-master-edition" });
  });

  it("aborts when the master edition has prints outstanding (N2)", () => {
    const verdict = evaluateNftGate(
      gateRead({ edition: { supply: "1" } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict).toEqual({ kind: "abort", reason: "has-prints" });
  });

  it("aborts unreadable on an unreadable token account", () => {
    const verdict = evaluateNftGate(
      gateRead({ token: { kind: "unreadable" } }),
      candidate.mint,
      OWNER_B58
    );
    expect(verdict).toEqual({ kind: "abort", reason: "unreadable" });
  });
});

/* ------------------------------------------------------------------ */
/* The hand-built BurnNft wire                                         */
/* ------------------------------------------------------------------ */

describe("buildBurnNftInstruction (the memo §3.1 wire)", () => {
  it("builds exactly the seven-key shape when a verified collection exists", () => {
    const token = Keypair.generate().publicKey;
    const ix = buildBurnNftInstruction(
      {
        mint: SAGA_MINT,
        tokenPubkey: token.toBase58(),
        collectionKey: SAGA_COLLECTION_MINT,
      },
      OWNER.publicKey
    );
    expect(ix.programId.toBase58()).toBe(
      METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBase58()
    );
    expect(Array.from(ix.data)).toEqual([BURN_NFT_TAG]);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      SAGA_METADATA_PDA, // metadata PDA, derived from the mint
      OWNER.publicKey.toBase58(), // owner: writable, the only signer
      SAGA_MINT, // mint: writable
      token.toBase58(), // token account: writable
      SAGA_EDITION_PDA, // master edition PDA, derived from the mint
      TOKEN_PROGRAM_ID.toBase58(), // SPL token program: readonly
      findMetadataPda(new PublicKey(SAGA_COLLECTION_MINT)).toBase58(),
    ]);
    expect(ix.keys.map((k) => k.isWritable)).toEqual([
      true, true, true, true, true, false, true,
    ]);
    expect(ix.keys.map((k) => k.isSigner)).toEqual([
      false, true, false, false, false, false, false,
    ]);
  });

  it("builds the six-key shape without a collection", () => {
    const ix = buildBurnNftInstruction(
      {
        mint: SAGA_MINT,
        tokenPubkey: Keypair.generate().publicKey.toBase58(),
        collectionKey: null,
      },
      OWNER.publicKey
    );
    expect(ix.keys).toHaveLength(6);
    expect(ix.data).toHaveLength(1);
    expect(ix.data[0]).toBe(BURN_NFT_TAG);
  });
});

/* ------------------------------------------------------------------ */
/* Copy: the house verbiage rules and the pinned sentences             */
/* ------------------------------------------------------------------ */

describe("nftBurn copy", () => {
  const allCopy: string[] = [
    ...Object.values(BURN_NFT_GATE_ABORT_COPY),
    NFT_ALREADY_GONE_COPY,
    NFT_METADATA_ONLY_COPY,
    NFT_BURN_CARD_PERMANENCE,
    NFT_BURN_CARD_COLLECTION,
    NFT_BURN_CARD_STRANDING,
  ];

  it("keeps the mechanical writing rules on every sentence", () => {
    for (const text of allCopy) {
      expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
      expect(text.includes("!")).toBe(false);
    }
  });

  it("uses curly apostrophes everywhere an apostrophe appears", () => {
    for (const text of allCopy) {
      expect(text.includes("'")).toBe(false);
    }
  });

  it("pins the N1-N7 abort rows to the memo's sentences", () => {
    expect(BURN_NFT_GATE_ABORT_COPY.frozen).toBe(
      "The fresh read reports this NFT\u2019s account as frozen, and a frozen account cannot be burned. Only the mint\u2019s freeze authority can unfreeze it. Nothing was signed."
    );
    expect(BURN_NFT_GATE_ABORT_COPY["has-prints"]).toBe(
      "The master edition behind this NFT still has print editions outstanding, and the network refuses to burn it until none remain. Nothing was signed."
    );
    expect(BURN_NFT_GATE_ABORT_COPY["foreign-program"]).toBe(
      "This token account is owned by the Token-2022 program, and the burn instruction this version offers runs on the SPL Token Program only. Nothing was signed."
    );
    expect(BURN_NFT_GATE_ABORT_COPY["not-master-edition"]).toBe(
      "The fresh read shows something other than a master edition at this NFT\u2019s edition address, so the network would refuse the burn. Nothing was signed."
    );
    expect(BURN_NFT_GATE_ABORT_COPY["metadata-missing"]).toBe(
      "The fresh read shows no metadata account behind this NFT, so the network would refuse the burn. Nothing was signed."
    );
  });

  it("pins the already-gone terminal with the stranded-rent truth", () => {
    expect(NFT_ALREADY_GONE_COPY).toBe(
      "This NFT\u2019s token account no longer exists. If it was burned through the plain token burn, its metadata and edition rent is stranded permanently; no one can claim it. Nothing was signed."
    );
  });

  it("pins the metadata-only terminal (the N7 honest sentence)", () => {
    expect(NFT_METADATA_ONLY_COPY).toBe(
      "No edition account exists behind this token, so there is no NFT burn. The token account itself can still be closed through the dust burn; the metadata deposit is unreachable by anyone, including this tool. Nothing was signed."
    );
  });

  it("pins the card's permanence, collection, and stranding sentences", () => {
    expect(NFT_BURN_CARD_PERMANENCE).toBe(
      "Burning is permanent. The NFT cannot be un-burned, the accounts disappear from the chain, and no one can restore them. SOL.REPAIR cannot judge what an NFT is worth, and burning is not undoable."
    );
    expect(NFT_BURN_CARD_COLLECTION).toBe(
      "This NFT belongs to a verified collection. Burning it reduces that collection\u2019s on-chain size by one."
    );
    expect(NFT_BURN_CARD_STRANDING).toBe(
      "This burn also closes the metadata and edition rent. Closing the account through the plain token burn instead strands that rent permanently: no instruction can reach it once the token is gone."
    );
  });

  it("pins the fee-era intro (the stored-create-fee shape)", () => {
    const intro = nftBurnCardIntroFeeEra("0.005115", "0.015115");
    expect(intro).toContain(
      "The three accounts\u2019 rent, 0.005115 SOL, returns to your wallet."
    );
    expect(intro).toContain(
      "The three deposits hold 0.015115 SOL in total; the metadata account carries a stored Metaplex create fee which stays in a one-byte husk that only Metaplex can claim."
    );
    // The mechanical rules hold on the variants too.
    for (const text of [intro]) {
      expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
      expect(text.includes("!")).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
      expect(text.includes("'")).toBe(false);
    }
  });
});

describe("the metadata close-return math (devnet-verified 2026-11-13)", () => {
  it("returns the balance when it is at or below today's rent-exempt minimum", () => {
    // The current cohort: every metadata priced exactly at today's
    // minimum, so the close is a real close and the deposit returns in
    // full.
    expect(metadataReturnLamports(3_733_800, 607, 3_733_800)).toBe(3_733_800);
    expect(metadataReturnLamports(1_000, 607, 3_733_800)).toBe(1_000);
  });

  it("caps the return at the rent-exempt minimum (the stored-fee shape)", () => {
    // A fee-era metadata: rent-exempt deposit plus the stored
    // Metaplex create fee; the close returns the deposit and leaves
    // the fee in the husk.
    expect(metadataReturnLamports(15_115_600, 607, 3_733_800)).toBe(3_733_800);
  });

  it("recognizes the closed-with-fee husk shape", () => {
    expect(isMetadataFeeHusk(Buffer.from([0]))).toBe(true);
    expect(isMetadataFeeHusk(Buffer.from([4]))).toBe(false);
    expect(isMetadataFeeHusk(Buffer.alloc(607))).toBe(false);
    expect(isMetadataFeeHusk(Buffer.alloc(0))).toBe(false);
  });
});
