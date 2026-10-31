/**
 * The authority-naming decode module (the v2 spec,
 * docs/authority-naming-spec-draft.md): the known-authority registry,
 * the imitation detector, and the Token-2022 mint name/symbol decode
 * with its one chunked read.
 *
 * The registry and detector are pure string logic pinned to the spec's
 * boundary values. The decode is the SDK 0.4.15 pure path verified in
 * the implementation gate (unpackMint -> getExtensionData ->
 * spl-token-metadata unpack), and the read dedupes to distinct mints in
 * chunks of 100 with zero calls when there is nothing to read. A failed
 * read, a vanished mint, or malformed bytes produce no label, never a
 * thrown error: report, never guess.
 */

import { describe, expect, it } from "vitest";
import { pack } from "@solana/spl-token-metadata";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import {
  SYSTEM_PROGRAM_ADDRESS,
  authorityLabel,
  decodeMintAuthorities,
  decodeMintNameSymbol,
  readMintFacts,
} from "../src/lib/solana/authorityNaming";

const SYSTEM_PROGRAM_LABEL =
  "the system program. It cannot sign a token-account close.";
const IMITATION_LABEL =
  "has a long System Program-like address prefix. It is not the system program.";

/** An address-shaped string with exactly `n` leading "1" characters.
 *  The tail is ordinary base58 so the string stays a plausible address;
 *  the detector is pure string logic and never decodes the value. */
function withLeadingOnes(n: number): string {
  return "1".repeat(n) + "AbCdEfGhIjKlMnOpQrStUvWxYz23456789";
}

describe("the known-authority registry", () => {
  it("names the system program with the spec label", () => {
    expect(authorityLabel(SYSTEM_PROGRAM_ADDRESS)).toBe(SYSTEM_PROGRAM_LABEL);
  });

  it("returns null for an address it does not know", () => {
    expect(authorityLabel(withLeadingOnes(0))).toBeNull();
  });
});

describe("the imitation detector", () => {
  it("gives no label at 11 leading ones", () => {
    expect(authorityLabel(withLeadingOnes(11))).toBeNull();
  });

  it("labels at 12 leading ones", () => {
    expect(authorityLabel(withLeadingOnes(12))).toBe(IMITATION_LABEL);
  });

  it("never gives the imitation label to the real system program", () => {
    const label = authorityLabel(SYSTEM_PROGRAM_ADDRESS);
    expect(label).toBe(SYSTEM_PROGRAM_LABEL);
    expect(label).not.toBe(IMITATION_LABEL);
  });

  it("gives no label to an ordinary foreign address", () => {
    expect(authorityLabel(withLeadingOnes(0))).toBeNull();
    expect(authorityLabel(withLeadingOnes(3))).toBeNull();
  });

  it("keeps the label an observation: it never claims the address cannot sign", () => {
    expect(IMITATION_LABEL).not.toMatch(/cannot sign|never sign|unable to sign/);
  });

  it("states the lookalike fact without intent language", () => {
    // "Imitates" implies deliberate deception, which string logic cannot
    // establish. The label states what is provable from the address
    // alone: a long System Program-like prefix, and that the address is
    // not the system program. It adds no verdict about the holder.
    expect(IMITATION_LABEL).toBe(
      "has a long System Program-like address prefix. It is not the system program."
    );
    expect(IMITATION_LABEL).not.toMatch(
      /imitat|fake|scam|spoof|phish|malicious|vanity/i
    );
    expect(IMITATION_LABEL).toContain("It is not the system program.");
  });
});

/** A raw Token-2022 mint buffer: 165-byte base with the requested
 *  authorities set at the base layout's offsets, a one-byte account
 *  type (1 = Mint), then an optional TokenMetadata TLV list packed by
 *  the same SDK code the decode path uses. */
function t22MintBuffer(
  opts: {
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
    name?: string;
    symbol?: string;
  } = {}
): Buffer {
  const base = Buffer.alloc(165);
  if (opts.mintAuthority) {
    base.writeUInt32LE(1, 0);
    new PublicKey(opts.mintAuthority).toBuffer().copy(base, 4);
  }
  if (opts.freezeAuthority) {
    base.writeUInt32LE(1, 46);
    new PublicKey(opts.freezeAuthority).toBuffer().copy(base, 50);
  }
  base[44] = 6;
  base[45] = 1;
  const hasMeta = opts.name !== undefined || opts.symbol !== undefined;
  if (!hasMeta) {
    return Buffer.concat([base, Buffer.from([1])]);
  }
  const meta = pack({
    updateAuthority: PublicKey.default,
    mint: PublicKey.default,
    name: opts.name ?? "",
    symbol: opts.symbol ?? "",
    uri: "",
    additionalMetadata: [],
  });
  const tlv = Buffer.alloc(4 + meta.length);
  tlv.writeUInt16LE(19, 0); // ExtensionType.TokenMetadata
  tlv.writeUInt16LE(meta.length, 2);
  Buffer.from(meta).copy(tlv, 4);
  return Buffer.concat([base, Buffer.from([1]), tlv]);
}

/** The v2 mint buffer: name and symbol only, base area all zeros. */
function mintBuffer(name: string, symbol: string): Buffer {
  return t22MintBuffer({ name, symbol });
}

/** A classic SPL mint buffer: exactly the 82-byte mint layout, option
 *  u32 little-endian then the key, at the documented offsets. */
function classicMintBuffer(
  opts: { mintAuthority?: string | null; freezeAuthority?: string | null } = {}
): Buffer {
  const data = Buffer.alloc(82);
  if (opts.mintAuthority) {
    data.writeUInt32LE(1, 0);
    new PublicKey(opts.mintAuthority).toBuffer().copy(data, 4);
  }
  data[44] = 9;
  data[45] = 1;
  if (opts.freezeAuthority) {
    data.writeUInt32LE(1, 46);
    new PublicKey(opts.freezeAuthority).toBuffer().copy(data, 50);
  }
  return data;
}

/** A mint reader mock recording every chunked call. Maps a mint address
 *  to the raw account info the RPC would return (null = vanished); a
 *  bare Buffer means the Token-2022 program owns it, as the chain
 *  returns for Token-2022 mints, and an explicit entry shape carries a
 *  different owner for classic fixtures. */
function mockMintReader(
  byMint: Record<
    string,
    Buffer | { owner: PublicKey; data: Buffer } | null
  > = {}
) {
  const calls: string[][] = [];
  return {
    calls,
    reader: {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        calls.push(keys.map((key) => key.toBase58()));
        return keys.map((key) => {
          const value = byMint[key.toBase58()];
          if (value === null || value === undefined) return null;
          if (Buffer.isBuffer(value)) {
            return { owner: TOKEN_2022_PROGRAM_ID, data: value };
          }
          return value;
        });
      },
    },
  };
}

const MINT_A = PublicKey.default.toBase58();
function mintKey(seed: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes).toBase58();
}

/** A mint address and the raw account info shape the decode consumes. */
const MINT_KEY = new PublicKey(Uint8Array.of(9));
function infoFor(data: Buffer): {
  owner: PublicKey;
  data: Buffer;
} {
  return { owner: TOKEN_2022_PROGRAM_ID, data };
}

describe("the mint metadata decode", () => {
  it("decodes a fixture carrying name and symbol", () => {
    const decoded = decodeMintNameSymbol(MINT_KEY, infoFor(mintBuffer("Test Token", "TST")));
    expect(decoded).toEqual({ name: "Test Token", symbol: "TST" });
  });

  it("gives no label when the mint carries no TokenMetadata extension", () => {
    // A bare mint is exactly the 82-byte base: unpackMint accepts it
    // with an empty extension list.
    expect(decodeMintNameSymbol(MINT_KEY, infoFor(Buffer.alloc(82)))).toBeNull();
  });

  it("gives no label on short or malformed metadata", () => {
    const good = mintBuffer("Test Token", "TST");
    expect(
      decodeMintNameSymbol(MINT_KEY, infoFor(good.subarray(0, good.length - 10)))
    ).toBeNull();
    const truncatedTlv = Buffer.concat([
      good.subarray(0, 166 + 4),
      good.subarray(166 + 4, 166 + 4 + 8),
    ]);
    expect(decodeMintNameSymbol(MINT_KEY, infoFor(truncatedTlv))).toBeNull();
    expect(decodeMintNameSymbol(MINT_KEY, null)).toBeNull();
  });
});

const AUTHORITY_A = mintKey(60);
const AUTHORITY_B = mintKey(61);

describe("the chunked distinct-mint read", () => {
  it("reads each distinct mint once and decodes names plus authority facts", async () => {
    const mintB = mintKey(2);
    const { reader, calls } = mockMintReader({
      [MINT_A]: mintBuffer("Test Token", "TST"),
      [mintB]: mintBuffer("MomoCoin", "MOMO"),
    });
    const facts = await readMintFacts(reader, [MINT_A, MINT_A, mintB]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([MINT_A, mintB]);
    expect(facts.get(MINT_A)?.name).toBe("Test Token");
    expect(facts.get(MINT_A)?.symbol).toBe("TST");
    expect(facts.get(mintB)?.name).toBe("MomoCoin");
    expect(facts.get(mintB)?.symbol).toBe("MOMO");
    // The zero base area of the fixture decodes to both authorities
    // revoked, so the facts carry the states, not absence.
    expect(facts.get(MINT_A)?.mintAuthorityActive).toBe(false);
    expect(facts.get(MINT_A)?.freezeAuthorityActive).toBe(false);
  });

  it("chunks at 100 mints per call", async () => {
    const mints = Array.from({ length: 101 }, (_, i) => mintKey(i + 3));
    const { reader, calls } = mockMintReader({});
    await readMintFacts(reader, mints);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(100);
    expect(calls[1]).toHaveLength(1);
  });

  it("makes zero calls for zero mints", async () => {
    const { reader, calls } = mockMintReader({});
    await readMintFacts(reader, []);
    expect(calls).toHaveLength(0);
  });

  it("treats a vanished mint as no facts", async () => {
    const { reader } = mockMintReader({});
    const facts = await readMintFacts(reader, [MINT_A]);
    expect(facts.get(MINT_A)).toBeUndefined();
  });

  it("treats a failed chunk call as no facts for the whole chunk, without throwing", async () => {
    const failing = {
      async getMultipleAccountsInfo() {
        throw new Error("429 too many requests");
      },
    };
    const facts = await readMintFacts(failing, [MINT_A, mintKey(2)]);
    expect(facts.size).toBe(0);
  });

  it("decodes classic mints through the same read, deduped across both programs", async () => {
    // The same mint string arriving from both token programs is read
    // once: dedupe is on the address, not the finding kind.
    const classic = classicMintBuffer({
      mintAuthority: AUTHORITY_A,
      freezeAuthority: AUTHORITY_B,
    });
    const { reader, calls } = mockMintReader({
      [MINT_A]: { owner: TOKEN_PROGRAM_ID, data: classic },
    });
    const facts = await readMintFacts(reader, [MINT_A, MINT_A]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([MINT_A]);
    expect(facts.get(MINT_A)).toEqual({
      mintAuthorityActive: true,
      mintAuthority: AUTHORITY_A,
      freezeAuthorityActive: true,
      freezeAuthority: AUTHORITY_B,
    });
  });

  it("carries authority facts alone for a Token-2022 mint with no metadata", async () => {
    const { reader } = mockMintReader({
      [MINT_A]: t22MintBuffer({ mintAuthority: AUTHORITY_A }),
    });
    const facts = await readMintFacts(reader, [MINT_A]);
    expect(facts.get(MINT_A)?.name).toBeUndefined();
    expect(facts.get(MINT_A)?.mintAuthorityActive).toBe(true);
    expect(facts.get(MINT_A)?.mintAuthority).toBe(AUTHORITY_A);
    expect(facts.get(MINT_A)?.freezeAuthorityActive).toBe(false);
  });
});

describe("the mint authority decode", () => {
  it("decodes a classic mint with both authorities active", () => {
    const decoded = decodeMintAuthorities(MINT_KEY, {
      owner: TOKEN_PROGRAM_ID,
      data: classicMintBuffer({
        mintAuthority: AUTHORITY_A,
        freezeAuthority: AUTHORITY_B,
      }),
    });
    expect(decoded).toEqual({
      mintAuthorityActive: true,
      mintAuthority: AUTHORITY_A,
      freezeAuthorityActive: true,
      freezeAuthority: AUTHORITY_B,
    });
  });

  it("decodes a classic mint with both authorities revoked", () => {
    const decoded = decodeMintAuthorities(MINT_KEY, {
      owner: TOKEN_PROGRAM_ID,
      data: classicMintBuffer({}),
    });
    expect(decoded).toEqual({
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
    });
  });

  it("decodes the mixed classic cases at the documented offsets", () => {
    const mintOnly = decodeMintAuthorities(MINT_KEY, {
      owner: TOKEN_PROGRAM_ID,
      data: classicMintBuffer({ mintAuthority: AUTHORITY_A }),
    });
    expect(mintOnly).toEqual({
      mintAuthorityActive: true,
      mintAuthority: AUTHORITY_A,
      freezeAuthorityActive: false,
    });
    const freezeOnly = decodeMintAuthorities(MINT_KEY, {
      owner: TOKEN_PROGRAM_ID,
      data: classicMintBuffer({ freezeAuthority: AUTHORITY_B }),
    });
    expect(freezeOnly).toEqual({
      mintAuthorityActive: false,
      freezeAuthorityActive: true,
      freezeAuthority: AUTHORITY_B,
    });
  });

  it("decodes a Token-2022 mint through unpackMint with both authorities active", () => {
    const decoded = decodeMintAuthorities(MINT_KEY, {
      owner: TOKEN_2022_PROGRAM_ID,
      data: t22MintBuffer({
        mintAuthority: AUTHORITY_A,
        freezeAuthority: AUTHORITY_B,
      }),
    });
    expect(decoded).toEqual({
      mintAuthorityActive: true,
      mintAuthority: AUTHORITY_A,
      freezeAuthorityActive: true,
      freezeAuthority: AUTHORITY_B,
    });
  });

  it("decodes a Token-2022 mint with both authorities revoked", () => {
    const decoded = decodeMintAuthorities(MINT_KEY, {
      owner: TOKEN_2022_PROGRAM_ID,
      data: t22MintBuffer({}),
    });
    expect(decoded).toEqual({
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
    });
  });

  it("gives no facts for an account whose owner is neither token program", () => {
    expect(
      decodeMintAuthorities(MINT_KEY, {
        owner: MINT_KEY,
        data: classicMintBuffer({ mintAuthority: AUTHORITY_A }),
      })
    ).toBeNull();
  });

  it("gives no facts for a classic account that is not the 82-byte mint shape", () => {
    // A multisig is 355 bytes and owned by a token program; the classic
    // decode reads only the exact mint layout.
    const multisig = Buffer.alloc(355);
    multisig.writeUInt32LE(1, 0);
    expect(
      decodeMintAuthorities(MINT_KEY, { owner: TOKEN_PROGRAM_ID, data: multisig })
    ).toBeNull();
    expect(
      decodeMintAuthorities(MINT_KEY, {
        owner: TOKEN_PROGRAM_ID,
        data: Buffer.alloc(81),
      })
    ).toBeNull();
    expect(
      decodeMintAuthorities(MINT_KEY, {
        owner: TOKEN_PROGRAM_ID,
        data: Buffer.alloc(83),
      })
    ).toBeNull();
  });

  it("decodes an all-zero mint shape to both-revoked, without throwing", () => {
    // The all-zero 82-byte shape is what an unformatted account looks
    // like to both decode paths; the offsets and unpackMint read the
    // same bytes and both report the zero option flags. The scan only
    // feeds this decode mints named by real token accounts, which the
    // token programs keep initialized, so the shape exists only in
    // fixtures - what is pinned here is that the decode never throws
    // and says exactly what the bytes say.
    expect(
      decodeMintAuthorities(MINT_KEY, {
        owner: TOKEN_2022_PROGRAM_ID,
        data: Buffer.alloc(82),
      })
    ).toEqual({ mintAuthorityActive: false, freezeAuthorityActive: false });
    expect(
      decodeMintAuthorities(MINT_KEY, {
        owner: TOKEN_PROGRAM_ID,
        data: Buffer.alloc(82),
      })
    ).toEqual({ mintAuthorityActive: false, freezeAuthorityActive: false });
    const truncated = t22MintBuffer({
      mintAuthority: AUTHORITY_A,
    }).subarray(0, 90);
    expect(
      decodeMintAuthorities(MINT_KEY, {
        owner: TOKEN_2022_PROGRAM_ID,
        data: truncated,
      })
    ).toBeNull();
    expect(decodeMintAuthorities(MINT_KEY, null)).toBeNull();
  });
});
