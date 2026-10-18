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
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import {
  SYSTEM_PROGRAM_ADDRESS,
  authorityLabel,
  decodeMintNameSymbol,
  readMintNames,
} from "../src/lib/solana/authorityNaming";

const SYSTEM_PROGRAM_LABEL =
  "the system program. It cannot sign a token-account close.";
const IMITATION_LABEL =
  "imitates the system program. It is not the system program.";

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
});

/** A raw Token-2022 mint buffer carrying a TokenMetadata extension
 *  packed by the same SDK code the decode path uses. */
function mintBuffer(name: string, symbol: string): Buffer {
  const meta = pack({
    updateAuthority: PublicKey.default,
    mint: PublicKey.default,
    name,
    symbol,
    uri: "",
    additionalMetadata: [],
  });
  const tlv = Buffer.alloc(4 + meta.length);
  tlv.writeUInt16LE(19, 0); // ExtensionType.TokenMetadata
  tlv.writeUInt16LE(meta.length, 2);
  Buffer.from(meta).copy(tlv, 4);
  // Layout per unpackMint (and the chain): 165-byte base area, a
  // one-byte account type (1 = Mint), then the TLV list.
  return Buffer.concat([Buffer.alloc(165), Buffer.from([1]), tlv]);
}

/** A mint reader mock recording every chunked call. Maps a mint address
 *  to the raw account info the RPC would return (null = vanished); the
 *  owner is the Token-2022 program, as the chain returns for mints. */
function mockMintReader(byMint: Record<string, Buffer | null> = {}) {
  const calls: string[][] = [];
  return {
    calls,
    reader: {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        calls.push(keys.map((key) => key.toBase58()));
        return keys.map((key) => {
          const data = byMint[key.toBase58()];
          if (data === null || data === undefined) return null;
          return { owner: TOKEN_2022_PROGRAM_ID, data };
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

describe("the chunked distinct-mint read", () => {
  it("reads each distinct mint once and decodes the names", async () => {
    const mintB = mintKey(2);
    const { reader, calls } = mockMintReader({
      [MINT_A]: mintBuffer("Test Token", "TST"),
      [mintB]: mintBuffer("MomoCoin", "MOMO"),
    });
    const names = await readMintNames(reader, [MINT_A, MINT_A, mintB]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([MINT_A, mintB]);
    expect(names.get(MINT_A)).toEqual({ name: "Test Token", symbol: "TST" });
    expect(names.get(mintB)).toEqual({ name: "MomoCoin", symbol: "MOMO" });
  });

  it("chunks at 100 mints per call", async () => {
    const mints = Array.from({ length: 101 }, (_, i) => mintKey(i + 3));
    const { reader, calls } = mockMintReader({});
    await readMintNames(reader, mints);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(100);
    expect(calls[1]).toHaveLength(1);
  });

  it("makes zero calls for zero mints", async () => {
    const { reader, calls } = mockMintReader({});
    await readMintNames(reader, []);
    expect(calls).toHaveLength(0);
  });

  it("treats a vanished mint as no label", async () => {
    const { reader } = mockMintReader({});
    const names = await readMintNames(reader, [MINT_A]);
    expect(names.get(MINT_A)).toBeUndefined();
  });

  it("treats a failed chunk call as no label for the whole chunk, without throwing", async () => {
    const failing = {
      async getMultipleAccountsInfo() {
        throw new Error("429 too many requests");
      },
    };
    const names = await readMintNames(failing, [MINT_A, mintKey(2)]);
    expect(names.size).toBe(0);
  });
});
