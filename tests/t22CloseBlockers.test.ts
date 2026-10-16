/**
 * Fixture tests for the Token-2022 close-blocker check
 * (t22CloseBlockers.ts).
 *
 * The wire facts these fixtures pin are source-verified against the
 * Token-2022 program at program@v11.1.0 (interface crate): the
 * close-account processor refuses an account whose TransferFeeAmount
 * withheld amount is non-zero, whose ConfidentialTransferAccount
 * pending_balance_lo, pending_balance_hi, or available_balance
 * ciphertext is non-zero, or whose ConfidentialTransferFeeAmount
 * withheld ciphertext is non-zero. The extension list is a
 * typed-length-value sequence after the 165-byte base account and a
 * one-byte account type: two-byte little-endian type, two-byte
 * little-endian length, then the value.
 *
 * The byte offsets below (33, 97, and 161 inside the
 * confidential-transfer entry, 0 inside the confidential-fee entry) come
 * from the on-chain state structs and are pinned here on purpose: if the
 * layout ever disagrees, these tests fail before any user does.
 *
 * Only the RPC boundary is mocked; the classification under test is the
 * real one. Every test here is expected to pass against the current
 * code. A failure means a fixture or the check changed behavior. It is a
 * stop-and-report event: production code is never edited to satisfy a
 * test.
 */

import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import {
  classifyCloseBlockers,
  readCloseBlockers,
} from "../src/lib/solana/t22CloseBlockers";
import { TOKEN_2022_PROGRAM_ID as APP_T22 } from "../src/lib/solana/tokenAccounts";

/** Build raw Token-2022 account data: 165-byte base, the account-type
 * byte 2 (AccountType.Account; Mint is 1), then the TLV entries. Types
 * and lengths are u16 LE, exactly as the program serializes them. */
function t22Data(entries: Array<[number, Buffer]>): Buffer {
  const chunks = entries.map(([type, value]) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(value.length, 2);
    return Buffer.concat([head, value]);
  });
  return Buffer.concat([Buffer.alloc(165), Buffer.from([2]), ...chunks]);
}

/** A full-size ConfidentialTransferAccount extension value (331 bytes)
 * with one byte set, mirroring a non-zero ciphertext at that offset. */
function confidentialEntry(nonZeroOffset: number | null): Buffer {
  const value = Buffer.alloc(331);
  if (nonZeroOffset !== null) value[nonZeroOffset] = 1;
  return value;
}

/** u64 LE amount, the TransferFeeAmount layout's only field. */
function u64le(amount: bigint): Buffer {
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(amount);
  return value;
}

function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

describe("classifyCloseBlockers", () => {
  it("returns null for an empty extension list", () => {
    expect(classifyCloseBlockers(Buffer.alloc(0))).toBeNull();
  });

  it("flags a non-zero withheld transfer fee", () => {
    const data = t22Data([[2, u64le(500n)]]);
    expect(classifyCloseBlockers(data.subarray(166))).toBe("withheld-fee");
  });

  it("passes a present-but-zero withheld transfer fee", () => {
    const data = t22Data([[2, u64le(0n)]]);
    expect(classifyCloseBlockers(data.subarray(166))).toBeNull();
  });

  it("flags a non-zero pending_balance_lo ciphertext (offset 33)", () => {
    const data = t22Data([[5, confidentialEntry(33)]]);
    expect(classifyCloseBlockers(data.subarray(166))).toBe(
      "confidential-balance"
    );
  });

  it("flags a non-zero pending_balance_hi ciphertext (offset 97)", () => {
    const data = t22Data([[5, confidentialEntry(97)]]);
    expect(classifyCloseBlockers(data.subarray(166))).toBe(
      "confidential-balance"
    );
  });

  it("flags a non-zero available_balance ciphertext (offset 161)", () => {
    const data = t22Data([[5, confidentialEntry(161)]]);
    expect(classifyCloseBlockers(data.subarray(166))).toBe(
      "confidential-balance"
    );
  });

  it("passes an all-zero confidential-transfer extension", () => {
    const data = t22Data([[5, confidentialEntry(null)]]);
    expect(classifyCloseBlockers(data.subarray(166))).toBeNull();
  });

  it("flags a non-zero confidential withheld fee (type 17, offset 0)", () => {
    const value = Buffer.alloc(64);
    value[0] = 1;
    const data = t22Data([[17, value]]);
    expect(classifyCloseBlockers(data.subarray(166))).toBe(
      "confidential-balance"
    );
  });

  it("passes a zero confidential withheld fee (type 17)", () => {
    const data = t22Data([[17, Buffer.alloc(64)]]);
    expect(classifyCloseBlockers(data.subarray(166))).toBeNull();
  });

  it("passes an ImmutableOwner-only account (over-exclusion guard)", () => {
    // Every Token-2022 ATA carries ImmutableOwner (type 7, no data). It
    // does not block a close, so the account must stay eligible.
    const data = t22Data([[7, Buffer.alloc(0)]]);
    expect(classifyCloseBlockers(data.subarray(166))).toBeNull();
  });

  it("passes an unknown future extension type", () => {
    // Extension types newer than this app must pass through unheard.
    const data = t22Data([[29, Buffer.alloc(12, 7)]]);
    expect(classifyCloseBlockers(data.subarray(166))).toBeNull();
  });

  it("reports the withheld fee when both blockers are present", () => {
    const value = Buffer.alloc(64);
    value[0] = 1;
    const data = t22Data([
      [2, u64le(1n)],
      [17, value],
    ]);
    expect(classifyCloseBlockers(data.subarray(166))).toBe("withheld-fee");
  });

  it("throws on a truncated confidential-transfer entry", () => {
    const data = t22Data([[5, Buffer.alloc(10)]]);
    expect(() => classifyCloseBlockers(data.subarray(166))).toThrow();
  });

  it("throws on a truncated confidential-fee entry", () => {
    const data = t22Data([[17, Buffer.alloc(10)]]);
    expect(() => classifyCloseBlockers(data.subarray(166))).toThrow();
  });

  it("throws on a truncated transfer-fee entry", () => {
    const data = t22Data([[2, Buffer.alloc(4)]]);
    expect(() => classifyCloseBlockers(data.subarray(166))).toThrow();
  });
});

/** The one mocked boundary: the chunked raw-account read. */
function mockReader(
  byPubkey: Record<string, { owner: PublicKey; data: Buffer } | null>
) {
  const calls: number[] = [];
  const connection = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      calls.push(keys.length);
      return keys.map((key) => {
        // An explicit null (vanished account) must stay null, so the
        // lookup is keyed, not defaulted.
        const entry = byPubkey[key.toBase58()];
        return (
          key.toBase58() in byPubkey
            ? entry
            : {
                owner: TOKEN_2022_PROGRAM_ID,
                data: Buffer.alloc(165),
              }
        ) as { lamports: number; owner: PublicKey; data: Buffer } | null;
      });
    },
  };
  return { connection, calls };
}

describe("readCloseBlockers", () => {
  it("reads a clean no-extension account as clear", async () => {
    const { connection, calls } = mockReader({});
    const key = pk(1).toBase58();
    const reads = await readCloseBlockers(connection, [key]);
    expect(reads.get(key)).toEqual({ status: "clear" });
    expect(calls).toEqual([1]);
  });

  it("reads a withheld-fee account as blocked", async () => {
    const key = pk(2).toBase58();
    const { connection } = mockReader({
      [key]: { owner: TOKEN_2022_PROGRAM_ID, data: t22Data([[2, u64le(9n)]]) },
    });
    const reads = await readCloseBlockers(connection, [key]);
    expect(reads.get(key)).toEqual({
      status: "blocked",
      blocker: "withheld-fee",
    });
  });

  it("reads a vanished account (null) as unreadable", async () => {
    const key = pk(3).toBase58();
    const { connection } = mockReader({ [key]: null });
    const reads = await readCloseBlockers(connection, [key]);
    expect(reads.get(key)).toEqual({ status: "unreadable" });
  });

  it("reads an account recreated under another program as unreadable", async () => {
    const key = pk(4).toBase58();
    const { connection } = mockReader({
      [key]: { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) },
    });
    const reads = await readCloseBlockers(connection, [key]);
    expect(reads.get(key)).toEqual({ status: "unreadable" });
  });

  it("reads a malformed extension list as unreadable", async () => {
    const key = pk(5).toBase58();
    const { connection } = mockReader({
      [key]: { owner: TOKEN_2022_PROGRAM_ID, data: t22Data([[5, Buffer.alloc(3)]]) },
    });
    const reads = await readCloseBlockers(connection, [key]);
    expect(reads.get(key)).toEqual({ status: "unreadable" });
  });

  it("chunks the read at 100 keys per call", async () => {
    const keys = Array.from({ length: 150 }, (_, i) => pk(100 + i).toBase58());
    const { connection, calls } = mockReader({});
    const reads = await readCloseBlockers(connection, keys);
    expect(calls).toEqual([100, 50]);
    expect(reads.size).toBe(150);
  });

  it("issues no RPC call for an empty key list", async () => {
    const { connection, calls } = mockReader({});
    const reads = await readCloseBlockers(connection, []);
    expect(calls).toEqual([]);
    expect(reads.size).toBe(0);
  });

  it("keeps the app and SDK Token-2022 program ids identical", () => {
    // The check validates info.owner against the SDK's constant; the
    // scan and builders use the app's. They must be the same address.
    expect(APP_T22.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });
});
