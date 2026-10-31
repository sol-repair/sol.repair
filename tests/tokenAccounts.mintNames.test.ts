/**
 * Scan integration for the authority-naming v2 spec and the mint and
 * freeze authority display spec (Rev 1, section 3): the one chunked
 * read of ALL distinct mints behind the wallet's token accounts, whose
 * response bytes serve the Token-2022 name decode (unchanged, attached
 * only to the two foreign-close-authority kinds) and the new per-mint
 * authority evidence (attached to every skip whose mint decoded).
 *
 * Pinned here, per the specs: distinct-mint dedupe across both token
 * programs; chunking at 100; a failed or empty decode leaves the skip
 * entry unchanged; and the scan's decisions (eligibility, causes,
 * reasons, lamports) are byte-identical with and without the evidence.
 * The v2 pins that the read set never includes classic mints and never
 * fires without foreign-close-authority accounts were superseded by the
 * display spec's widened read set and are rewritten here to pin the
 * widened contract instead.
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

/** A raw Token-2022 mint buffer with authorities set at the base
 *  layout's offsets, an initialized base, and an optional TokenMetadata
 *  extension. */
function t22MintBufferWithAuthorities(
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
  const typeByte = Buffer.from([1]);
  if (opts.name === undefined && opts.symbol === undefined) {
    return Buffer.concat([base, typeByte]);
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
  tlv.writeUInt16LE(19, 0);
  tlv.writeUInt16LE(meta.length, 2);
  Buffer.from(meta).copy(tlv, 4);
  return Buffer.concat([base, typeByte, tlv]);
}

/** A raw classic SPL mint buffer: exactly the 82-byte layout. */
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

/** Mock the two RPC boundaries the scan touches: the parsed accounts
 *  call, and getMultipleAccountsInfo, which now serves BOTH the
 *  close-blocker read (keyed by account pubkey) and the mint read
 *  (keyed by mint pubkey). mintByAddress answers the mint read; a bare
 *  Buffer means the Token-2022 program owns the account, and an
 *  explicit shape carries a different owner (classic fixtures).
 *  Every chunked call is recorded. */
function mockConnection(
  byProgram: Record<string, ReturnType<typeof tokenAccount>[]>,
  rawByPubkey: Record<string, { owner: PublicKey; data: Buffer } | null> = {},
  mintByAddress: Record<
    string,
    Buffer | { owner: PublicKey; data: Buffer } | null
  > = {}
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
        const entry = mintByAddress[address];
        if (address in mintByAddress) {
          if (entry === null) return null;
          if (Buffer.isBuffer(entry)) {
            return { owner: TOKEN_2022_PROGRAM_ID, data: entry };
          }
          return entry;
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
  mintByAddress: Record<
    string,
    Buffer | { owner: PublicKey; data: Buffer } | null
  > = {}
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

  it("reads a classic-program mint too (the widened read set)", async () => {
    // Supersedes the v2 pin "never reads a classic-program mint": the
    // display spec's widened set is all distinct mints behind the
    // wallet's token accounts, both programs. The name evidence still
    // never lands on the entry (no on-chain name exists for a classic
    // mint), while the authority facts do.
    const classic = tokenAccount(2, {
      closeAuthority: FOREIGN_AUTHORITY,
      program: "spl",
    });
    const { result, rawCalls } = await runScan(
      [classic],
      [],
      {},
      {
        [pk(102).toBase58()]: {
          owner: TOKEN_PROGRAM_ID,
          data: classicMintBuffer({ freezeAuthority: FOREIGN_AUTHORITY }),
        },
      }
    );
    expect(result.skippedAccounts[0].cause).toBe("close-authority");
    expect(result.skippedAccounts[0].mintName).toBeUndefined();
    expect(result.skippedAccounts[0].mintSymbol).toBeUndefined();
    expect(result.skippedAccounts[0].mintAuthorityActive).toBe(false);
    expect(result.skippedAccounts[0].freezeAuthorityActive).toBe(true);
    expect(result.skippedAccounts[0].freezeAuthority).toBe(FOREIGN_AUTHORITY);
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0]).toEqual([pk(102).toBase58()]);
  });

  it("reads every distinct held mint once even with no foreign-close-authority account", async () => {
    // Supersedes the v2 pin "makes zero additional reads when no
    // foreign-close-authority account exists": the widened read set
    // covers all held mints, so a plain wallet's mints are read once,
    // deduped across both programs.
    const { rawCalls } = await runScan(
      [tokenAccount(2)],
      [tokenAccount(3, { balance: "5", program: "token-2022" })],
      {},
      {}
    );
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0]).toEqual([
      pk(102).toBase58(),
      pk(103).toBase58(),
    ]);
  });

  it("attaches mint and freeze authority evidence to a frozen funded skip", async () => {
    const funded = tokenAccount(3, {
      balance: "100",
      program: "spl",
      // tokenAccount sets state initialized; a frozen funded account
      // carries the frozen flag instead of the reason swap only for
      // T22 fixtures below, so force the state here.
    });
    funded.account.data.parsed.info.mint = pk(102).toBase58();
    funded.account.data.parsed.info.state = "frozen";
    const { result } = await runScan(
      [funded],
      [],
      {},
      {
        [pk(102).toBase58()]: {
          owner: TOKEN_PROGRAM_ID,
          data: classicMintBuffer({
            mintAuthority: null,
            freezeAuthority: FOREIGN_AUTHORITY,
          }),
        },
      }
    );
    expect(result.skippedAccounts[0].cause).toBe("funded");
    expect(result.skippedAccounts[0].frozen).toBe(true);
    expect(result.skippedAccounts[0].mintAuthorityActive).toBe(false);
    expect(result.skippedAccounts[0].freezeAuthorityActive).toBe(true);
    expect(result.skippedAccounts[0].freezeAuthority).toBe(FOREIGN_AUTHORITY);
  });

  it("keeps name evidence scoped to the two foreign-close-authority kinds", async () => {
    // The widened read decodes names for every T22 mint, but the v2
    // attachment scope is unchanged: a funded skip without a foreign
    // close authority gets authority facts, never a mint name.
    const funded = tokenAccount(3, {
      balance: "5",
      program: "token-2022",
    });
    funded.account.data.parsed.info.mint = MINT_1;
    const { result } = await runScan(
      [],
      [funded],
      {},
      {
        [MINT_1]: t22MintBufferWithAuthorities({
          name: "MomoCoin",
          symbol: "MOMO",
        }),
      }
    );
    expect(result.skippedAccounts[0].cause).toBe("funded");
    expect(result.skippedAccounts[0].mintName).toBeUndefined();
    expect(result.skippedAccounts[0].mintSymbol).toBeUndefined();
    expect(result.skippedAccounts[0].mintAuthorityActive).toBe(false);
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
