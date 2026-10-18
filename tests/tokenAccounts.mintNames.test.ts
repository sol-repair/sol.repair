/**
 * Scan integration for the authority-naming v2 spec: the one chunked
 * read that attaches Token-2022 mint name/symbol evidence to the two
 * foreign-close-authority skip kinds.
 *
 * Pinned here, per the spec: zero additional reads on any scan with no
 * foreign-close-authority accounts; classic-program mints never read;
 * distinct-mint dedupe; a failed or empty decode leaves the skip entry
 * unchanged; and the scan's decisions (eligibility, causes, reasons,
 * lamports) are byte-identical with and without the metadata evidence.
 */

import { describe, expect, it } from "vitest";
import { pack } from "@solana/spl-token-metadata";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getClosableAccounts,
} from "../src/lib/solana/tokenAccounts";

function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

const OWNER = pk(1);
const FOREIGN_AUTHORITY = pk(50).toBase58();

/** A parsed SPL/Token-2022 token-account fixture in the exact nested
 *  RPC shape. `balance` nonzero makes it a funded skip; closeAuthority
 *  set makes it a foreign-close-authority finding at its own site. */
function tokenAccount(
  seed: number,
  fields: {
    balance?: string;
    closeAuthority?: string;
    program?: "spl" | "token-2022";
  } = {}
) {
  const programId =
    fields.program === "token-2022"
      ? TOKEN_2022_PROGRAM_ID.toBase58()
      : TOKEN_PROGRAM_ID.toBase58();
  return {
    pubkey: pk(seed),
    account: {
      lamports: 2_039_280,
      owner: programId,
      data: {
        parsed: {
          info: {
            mint: pk(seed + 100).toBase58(),
            owner: OWNER.toBase58(),
            tokenAmount: {
              amount: fields.balance ?? "0",
              decimals: 6,
              uiAmount: 0,
              uiAmountString: fields.balance ?? "0",
            },
            state: "initialized",
            isNative: false,
            ...(fields.closeAuthority
              ? { closeAuthority: fields.closeAuthority }
              : {}),
          },
        },
      },
    },
  };
}

/** A raw Token-2022 mint buffer carrying a TokenMetadata extension.
 *  Layout per unpackMint (and the chain): 165-byte base, one account
 *  type byte, then the TLV list. */
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
  tlv.writeUInt16LE(19, 0);
  tlv.writeUInt16LE(meta.length, 2);
  Buffer.from(meta).copy(tlv, 4);
  return Buffer.concat([Buffer.alloc(165), Buffer.from([1]), tlv]);
}

/** Mock the two RPC boundaries the scan touches: the parsed accounts
 *  call, and getMultipleAccountsInfo, which now serves BOTH the
 *  close-blocker read (keyed by account pubkey) and the mint-name read
 *  (keyed by mint pubkey). mintByAddress answers the mint-name read;
 *  anything it does not know falls through rawByPubkey, then to a
 *  clean extension-free account so unrelated fixtures are unaffected.
 *  Every chunked call is recorded. */
function mockConnection(
  byProgram: Record<string, ReturnType<typeof tokenAccount>[]>,
  rawByPubkey: Record<string, { owner: PublicKey; data: Buffer } | null> = {},
  mintByAddress: Record<string, Buffer | null> = {}
) {
  const rawCalls: string[][] = [];
  const connection = {
    async getParsedTokenAccountsByOwner(
      _owner: PublicKey,
      filter: { programId: PublicKey }
    ) {
      return { value: byProgram[filter.programId.toBase58()] ?? [] };
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      rawCalls.push(keys.map((key) => key.toBase58()));
      return keys.map((key) => {
        const address = key.toBase58();
        if (address in mintByAddress) {
          const data = mintByAddress[address];
          return data === null
            ? null
            : { owner: TOKEN_2022_PROGRAM_ID, data };
        }
        return address in rawByPubkey
          ? rawByPubkey[address]
          : {
              lamports: 2_039_280,
              owner: TOKEN_2022_PROGRAM_ID,
              data: Buffer.alloc(165),
            };
      });
    },
  };
  return { connection: connection as unknown as Connection, rawCalls };
}

async function runScan(
  splAccounts: ReturnType<typeof tokenAccount>[],
  token22Accounts: ReturnType<typeof tokenAccount>[],
  rawByPubkey: Record<string, { owner: PublicKey; data: Buffer } | null> = {},
  mintByAddress: Record<string, Buffer | null> = {}
) {
  const { connection, rawCalls } = mockConnection(
    {
      [TOKEN_PROGRAM_ID.toBase58()]: splAccounts,
      [TOKEN_2022_PROGRAM_ID.toBase58()]: token22Accounts,
    },
    rawByPubkey,
    mintByAddress
  );
  const result = await getClosableAccounts(connection, OWNER);
  return { result, rawCalls };
}

const MINT_1 = pk(200).toBase58();

describe("scan attaches mint name evidence to foreign-close-authority skips", () => {
  it("names the mint behind an empty foreign-close-authority skip", async () => {
    const skip = tokenAccount(2, {
      closeAuthority: FOREIGN_AUTHORITY,
      program: "token-2022",
    });
    // Point the fixture's mint at MINT_1 by rewriting the parsed mint.
    skip.account.data.parsed.info.mint = MINT_1;
    const { result, rawCalls } = await runScan(
      [],
      [skip],
      {},
      { [MINT_1]: mintBuffer("Test Token", "TST") }
    );
    expect(result.skippedAccounts).toHaveLength(1);
    expect(result.skippedAccounts[0].cause).toBe("close-authority");
    expect(result.skippedAccounts[0].mintName).toBe("Test Token");
    expect(result.skippedAccounts[0].mintSymbol).toBe("TST");
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0]).toEqual([MINT_1]);
  });

  it("names the mint behind a funded foreign-close-authority skip", async () => {
    const funded = tokenAccount(3, {
      balance: "100",
      closeAuthority: FOREIGN_AUTHORITY,
      program: "token-2022",
    });
    funded.account.data.parsed.info.mint = MINT_1;
    const { result, rawCalls } = await runScan(
      [],
      [funded],
      {},
      { [MINT_1]: mintBuffer("MomoCoin", "MOMO") }
    );
    expect(result.skippedAccounts[0].cause).toBe("funded");
    expect(result.skippedAccounts[0].foreignCloseAuthority).toBe(true);
    expect(result.skippedAccounts[0].mintName).toBe("MomoCoin");
    expect(result.skippedAccounts[0].mintSymbol).toBe("MOMO");
    expect(rawCalls).toHaveLength(1);
  });

  it("reads two accounts sharing one mint exactly once", async () => {
    const a = tokenAccount(2, {
      closeAuthority: FOREIGN_AUTHORITY,
      program: "token-2022",
    });
    const b = tokenAccount(3, {
      closeAuthority: FOREIGN_AUTHORITY,
      program: "token-2022",
    });
    a.account.data.parsed.info.mint = MINT_1;
    b.account.data.parsed.info.mint = MINT_1;
    const { result, rawCalls } = await runScan(
      [],
      [a, b],
      {},
      { [MINT_1]: mintBuffer("Test Token", "TST") }
    );
    expect(result.skippedAccounts).toHaveLength(2);
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0]).toEqual([MINT_1]);
    for (const entry of result.skippedAccounts) {
      expect(entry.mintName).toBe("Test Token");
    }
  });

  it("never reads a classic-program mint", async () => {
    const classic = tokenAccount(2, {
      closeAuthority: FOREIGN_AUTHORITY,
      program: "spl",
    });
    const { result, rawCalls } = await runScan([classic], [], {}, {});
    expect(result.skippedAccounts[0].cause).toBe("close-authority");
    expect(result.skippedAccounts[0].mintName).toBeUndefined();
    expect(rawCalls).toHaveLength(0);
  });

  it("makes zero additional reads when no foreign-close-authority account exists", async () => {
    const { rawCalls } = await runScan(
      [tokenAccount(2)],
      [tokenAccount(3, { balance: "5", program: "token-2022" })],
      {},
      {}
    );
    expect(rawCalls).toHaveLength(0);
  });

  it("leaves the skip entry unchanged when the read fails or comes back empty", async () => {
    const skip = tokenAccount(2, {
      closeAuthority: FOREIGN_AUTHORITY,
      program: "token-2022",
    });
    skip.account.data.parsed.info.mint = MINT_1;
    const { result } = await runScan([], [skip], {}, { [MINT_1]: null });
    expect(result.skippedAccounts[0].cause).toBe("close-authority");
    expect(result.skippedAccounts[0].mintName).toBeUndefined();
    expect(result.skippedAccounts[0].mintSymbol).toBeUndefined();
    expect(result.skippedAccounts[0].reason).toBe(
      "close authority belongs to another address"
    );
  });

  it("changes no scan decision, only adds evidence", async () => {
    const t22Funded = tokenAccount(3, {
      balance: "100",
      closeAuthority: FOREIGN_AUTHORITY,
      program: "token-2022",
    });
    const t22ForeignEmpty = tokenAccount(4, {
      closeAuthority: FOREIGN_AUTHORITY,
      program: "token-2022",
    });
    const splFunded = tokenAccount(5, { balance: "7", program: "spl" });

    const withoutMeta = await runScan(
      [splFunded],
      [t22Funded, t22ForeignEmpty],
      {},
      {}
    );
    const withMeta = await runScan(
      [splFunded],
      [t22Funded, t22ForeignEmpty],
      {},
      { [MINT_1]: mintBuffer("Test Token", "TST") }
    );

    const decision = (r: Awaited<ReturnType<typeof runScan>>["result"]) => ({
      totalAccounts: r.totalAccounts,
      eligible: r.eligibleAccounts,
      recoverable: r.recoverableLamports.toString(),
      skips: r.skippedAccounts.map((s) => ({
        pubkey: s.pubkey,
        cause: s.cause,
        reason: s.reason,
        program: s.program,
        balance: s.balance,
        closeAuthority: s.closeAuthority,
        foreignCloseAuthority: s.foreignCloseAuthority,
      })),
    });
    const base = decision(withoutMeta.result);
    const named = decision(withMeta.result);
    expect(named).toEqual(base);
    // And the named run really did read the mint.
    expect(withMeta.rawCalls).toHaveLength(1);
  });
});
