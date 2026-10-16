/**
 * Fixture tests for the Token-2022 mint-side burn blockers
 * (t22MintBurnBlockers.ts).
 *
 * The wire facts pinned here are source-verified against the Token-2022
 * program at program@v11.1.0 (process_burn): the standard Burn is
 * rejected when the mint carries a PermissionedBurnConfig with an
 * authority set (InvalidInstruction), a paused PausableConfig
 * (MintPaused), or a ConfidentialMintBurn extension
 * (IllegalMintBurnConversion). Presence alone is NOT the rule: a
 * transfer-fee mint, an unpaused mint, and a permissioned mint with a
 * null (all-zero) authority must all still burn. Those are the
 * over-exclusion guards.
 *
 * Raw mint data shape: 82-byte base padded to 165, the account-type
 * byte 1 (AccountType.Mint) at offset 165, then the TLV entries (u16 LE type, u16 LE
 * length, value). The on-chain PausableConfig layout is authority
 * (32 bytes) then paused (1 byte); PermissionedBurnConfig is the
 * authority alone (32 bytes, all zeros meaning null);
 * ConfidentialMintBurn is extension type 42 in the program's enum,
 * which the SDK 0.4.15 enum does not carry.
 *
 * Only the RPC boundary is mocked; the classification under test is
 * the real one. Every test is expected to pass against current code;
 * a failure is a stop-and-report event, never a production edit to
 * satisfy a test.
 */

import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import {
  classifyMintBurnBlockers,
  readMintBurnBlockers,
} from "../src/lib/solana/t22MintBurnBlockers";

function mintData(entries: Array<[number, Buffer]>): Buffer {
  const chunks = entries.map(([type, value]) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(value.length, 2);
    return Buffer.concat([head, value]);
  });
  return Buffer.concat([Buffer.alloc(165), Buffer.from([1]), ...chunks]);
}

function pausableValue(paused: boolean): Buffer {
  const value = Buffer.alloc(33);
  value.writeUInt8(paused ? 1 : 0, 32);
  return value;
}

function authorityValue(nonZero: boolean): Buffer {
  const value = Buffer.alloc(32);
  if (nonZero) value[0] = 1;
  return value;
}

function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

describe("classifyMintBurnBlockers", () => {
  it("returns null for an empty extension list", () => {
    expect(classifyMintBurnBlockers(Buffer.alloc(0))).toBeNull();
  });

  it("flags a paused mint", () => {
    const data = mintData([[26, pausableValue(true)]]);
    expect(classifyMintBurnBlockers(data.subarray(166))).toBe("paused");
  });

  it("passes an unpaused mint (over-exclusion guard)", () => {
    const data = mintData([[26, pausableValue(false)]]);
    expect(classifyMintBurnBlockers(data.subarray(166))).toBeNull();
  });

  it("flags a permissioned burn authority that is set", () => {
    const data = mintData([[28, authorityValue(true)]]);
    expect(classifyMintBurnBlockers(data.subarray(166))).toBe(
      "permissioned-burn"
    );
  });

  it("passes a permissioned config with a null (all-zero) authority", () => {
    const data = mintData([[28, authorityValue(false)]]);
    expect(classifyMintBurnBlockers(data.subarray(166))).toBeNull();
  });

  it("flags a confidential-mint-burn mint (type 42)", () => {
    const data = mintData([[42, Buffer.alloc(0)]]);
    expect(classifyMintBurnBlockers(data.subarray(166))).toBe(
      "confidential-mint-burn"
    );
  });

  it("passes a transfer-fee mint (over-exclusion guard: fee mints are common)", () => {
    const data = mintData([[1, Buffer.alloc(76)]]);
    expect(classifyMintBurnBlockers(data.subarray(166))).toBeNull();
  });

  it("reports paused first when several blockers are present", () => {
    const data = mintData([
      [28, authorityValue(true)],
      [26, pausableValue(true)],
    ]);
    expect(classifyMintBurnBlockers(data.subarray(166))).toBe("paused");
  });

  it("throws on a truncated pausable entry", () => {
    const data = mintData([[26, Buffer.alloc(10)]]);
    expect(() => classifyMintBurnBlockers(data.subarray(166))).toThrow();
  });

  it("throws on a truncated permissioned entry", () => {
    const data = mintData([[28, Buffer.alloc(4)]]);
    expect(() => classifyMintBurnBlockers(data.subarray(166))).toThrow();
  });
});

describe("readMintBurnBlockers", () => {
  function mockReader(
    info: { owner: PublicKey; data: Buffer } | null
  ) {
    const calls: PublicKey[] = [];
    const connection = {
      async getAccountInfo(key: PublicKey) {
        calls.push(key);
        return info;
      },
    };
    return { connection, calls };
  }

  it("reads a clean no-extension mint as clear", async () => {
    const { connection, calls } = mockReader({
      owner: TOKEN_2022_PROGRAM_ID,
      data: Buffer.alloc(82),
    });
    const read = await readMintBurnBlockers(connection, pk(1).toBase58());
    expect(read).toEqual({ status: "clear" });
    expect(calls).toHaveLength(1);
  });

  it("reads a paused mint as blocked", async () => {
    const { connection } = mockReader({
      owner: TOKEN_2022_PROGRAM_ID,
      data: mintData([[26, pausableValue(true)]]),
    });
    const read = await readMintBurnBlockers(connection, pk(2).toBase58());
    expect(read).toEqual({ status: "blocked", blocker: "paused" });
  });

  it("reads a vanished mint (null) as unreadable", async () => {
    const { connection } = mockReader(null);
    const read = await readMintBurnBlockers(connection, pk(3).toBase58());
    expect(read).toEqual({ status: "unreadable" });
  });

  it("reads a mint owned by another program as unreadable (decode validation exercised)", async () => {
    // The owner-ordered addition: a mint whose owning program is not
    // Token-2022 must land in the conservative-abort class, proving the
    // unpack validation runs rather than being assumed.
    const { connection } = mockReader({
      owner: TOKEN_PROGRAM_ID,
      data: Buffer.alloc(82),
    });
    const read = await readMintBurnBlockers(connection, pk(4).toBase58());
    expect(read).toEqual({ status: "unreadable" });
  });

  it("reads a malformed extension list as unreadable", async () => {
    const { connection } = mockReader({
      owner: TOKEN_2022_PROGRAM_ID,
      data: mintData([[26, Buffer.alloc(3)]]),
    });
    const read = await readMintBurnBlockers(connection, pk(5).toBase58());
    expect(read).toEqual({ status: "unreadable" });
  });

  it("never throws on an RPC failure", async () => {
    const connection = {
      async getAccountInfo() {
        throw new Error("network down");
      },
    };
    const read = await readMintBurnBlockers(connection, pk(6).toBase58());
    expect(read).toEqual({ status: "unreadable" });
  });
});
