/**
 * Fixture tests for the eligibility checks in tokenAccounts.ts: the five
 * parsed-state checks plus the Token-2022 extension-level close-blocker
 * check that runs after them.
 *
 * The account data here is frozen in the exact nested shape the parsed
 * RPC returns (account.data.parsed.info), including the cases where the
 * RPC omits a field entirely instead of sending null. Only the RPC
 * boundary is mocked; the eligibility logic under test is the real one.
 *
 * Every test here is expected to pass against the current code. A
 * failure means either a fixture is wrong or the checks changed
 * behavior. It is a stop-and-report event: production code is never
 * edited to satisfy a test.
 */

import { describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getClosableAccounts,
} from "../src/lib/solana/tokenAccounts";

/** Deterministic, unique test keys. Off-curve is fine: the scan only
 *  stringifies and compares them. */
function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

const OWNER = pk(1);

/** A clean, eligible account in the real parsed shape. Fixtures below
 *  override a single field each so every test isolates one rule. The
 *  accountOverrides argument reaches the account-level fields (lamports,
 *  owner) that sit outside the parsed data. */
function tokenAccount(
  seed: number,
  overrides: Record<string, unknown> = {},
  accountOverrides: Record<string, unknown> = {}
) {
  return {
    pubkey: pk(seed),
    account: {
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM_ID.toBase58(),
      ...accountOverrides,
      data: {
        parsed: {
          info: {
            mint: pk(seed + 100).toBase58(),
            owner: OWNER.toBase58(),
            tokenAmount: {
              amount: "0",
              decimals: 6,
              uiAmount: 0,
              uiAmountString: "0",
            },
            state: "initialized",
            isNative: false,
            ...overrides,
          },
        },
      },
    },
  };
}

/** An entry whose RPC `data` is not the parsed shape the scan requested.
 *  The cast back to the healthy fixture type is deliberate: a fixture
 *  needs to carry data a provider could really return, and the scan has
 *  to cope with whatever arrives. */
function brokenData(
  seed: number,
  data: unknown
): ReturnType<typeof tokenAccount> {
  return {
    pubkey: pk(seed),
    account: {
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM_ID.toBase58(),
      data,
    },
  } as ReturnType<typeof tokenAccount>;
}

/** The one mocked boundary: the parsed-accounts RPC call, keyed by
 * program id, exactly as the scan consumes it. The extension-check raw
 * read is mocked alongside it: rawByPubkey maps an account pubkey to the
 * raw Token-2022 account the chunked read returns (null = vanished);
 * accounts not in the map get a clean, extension-free account, so
 * fixtures that only exercise the parsed checks are unaffected. */
function mockConnection(
  byProgram: Record<string, ReturnType<typeof tokenAccount>[]>,
  rawByPubkey: Record<string, { owner: PublicKey; data: Buffer } | null> = {}
) {
  const queried: string[] = [];
  const rawCalls: number[] = [];
  const connection = {
    async getParsedTokenAccountsByOwner(
      _owner: PublicKey,
      filter: { programId: PublicKey }
    ) {
      queried.push(filter.programId.toBase58());
      return { value: byProgram[filter.programId.toBase58()] ?? [] };
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      rawCalls.push(keys.length);
      return keys.map((key) =>
        key.toBase58() in rawByPubkey
          ? rawByPubkey[key.toBase58()]
          : {
              lamports: 2_039_280,
              owner: TOKEN_2022_PROGRAM_ID,
              data: Buffer.alloc(165),
            }
      );
    },
  };
  return {
    connection: connection as unknown as Connection,
    queried,
    rawCalls,
  };
}

async function runScan(
  splAccounts: ReturnType<typeof tokenAccount>[] = [],
  token22Accounts: ReturnType<typeof tokenAccount>[] = [],
  rawByPubkey: Record<string, { owner: PublicKey; data: Buffer } | null> = {}
) {
  const { connection, queried, rawCalls } = mockConnection(
    {
      [TOKEN_PROGRAM_ID.toBase58()]: splAccounts,
      [TOKEN_2022_PROGRAM_ID.toBase58()]: token22Accounts,
    },
    rawByPubkey
  );
  const result = await getClosableAccounts(connection, OWNER);
  return { result, queried, rawCalls };
}

describe("getClosableAccounts eligibility checks", () => {
  it("marks a clean zero-balance account eligible with its rent", async () => {
    const { result } = await runScan([tokenAccount(2)]);
    expect(result.totalAccounts).toBe(1);
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.eligibleAccounts[0].lamports).toBe(2_039_280);
    expect(result.eligibleAccounts[0].program).toBe("spl");
    expect(result.recoverableLamports).toBe(2_039_280n);
    expect(result.skippedAccounts).toHaveLength(0);
  });

  it("skips a funded account, with the reason shown to users", async () => {
    const funded = tokenAccount(3, {
      tokenAmount: {
        amount: "100",
        decimals: 6,
        uiAmount: 0.0001,
        uiAmountString: "0.0001",
      },
    });
    const { result } = await runScan([funded]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts).toHaveLength(1);
    expect(result.skippedAccounts[0].reason).toBe("holds a token balance");
    expect(result.recoverableLamports).toBe(0n);
  });

  it("marks an empty delegated account eligible, flagged for revoke", async () => {
    const delegated = tokenAccount(4, {
      delegate: pk(5).toBase58(),
    });
    const { result } = await runScan([delegated]);
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.eligibleAccounts[0].needsRevoke).toBe(true);
    expect(result.recoverableLamports).toBe(2_039_280n);
    expect(result.skippedAccounts).toHaveLength(0);
  });

  it("still skips a FUNDED delegated account (balance check runs first)", async () => {
    const delegatedAndFunded = tokenAccount(4, {
      delegate: pk(5).toBase58(),
      tokenAmount: {
        amount: "77",
        decimals: 6,
        uiAmount: 0.000077,
        uiAmountString: "0.000077",
      },
    });
    const { result } = await runScan([delegatedAndFunded]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe("holds a token balance");
  });

  it("still skips a delegated account whose close authority is foreign", async () => {
    const delegated = tokenAccount(4, {
      delegate: pk(5).toBase58(),
      closeAuthority: pk(9).toBase58(),
    });
    const { result } = await runScan([delegated]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe(
      "close authority belongs to another address"
    );
  });

  it("still skips a delegated wrapped-SOL account", async () => {
    const delegated = tokenAccount(4, {
      delegate: pk(5).toBase58(),
      isNative: true,
    });
    const { result } = await runScan([delegated]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe("is a wrapped-SOL account");
  });

  it("records foreignCloseAuthority evidence on a funded skip with a foreign close authority", async () => {
    const foreign = tokenAccount(31, { closeAuthority: pk(32).toBase58(), tokenAmount: { amount: "77", decimals: 6, uiAmount: 0.000077, uiAmountString: "0.000077" } });
    const { result } = await runScan([foreign]);
    expect(result.eligibleAccounts).toHaveLength(0);
    const skipped = result.skippedAccounts[0];
    expect(skipped.cause).toBe("funded");
    expect(skipped.foreignCloseAuthority).toBe(true);
    // The address itself is carried alongside the boolean, as display
    // evidence for the summary's grouped list.
    expect(skipped.closeAuthority).toBe(pk(32).toBase58());
  });

  it("records no foreignCloseAuthority when the close authority is the owner (or absent)", async () => {
    const owned = tokenAccount(33, { closeAuthority: OWNER.toBase58(), tokenAmount: { amount: "77", decimals: 6, uiAmount: 0.000077, uiAmountString: "0.000077" } });
    const plain = tokenAccount(34, { tokenAmount: { amount: "77", decimals: 6, uiAmount: 0.000077, uiAmountString: "0.000077" } });
    const { result } = await runScan([owned, plain]);
    expect(result.skippedAccounts).toHaveLength(2);
    expect(result.skippedAccounts[0].foreignCloseAuthority).toBeUndefined();
    expect(result.skippedAccounts[1].foreignCloseAuthority).toBeUndefined();
    expect(result.skippedAccounts[0].closeAuthority).toBeUndefined();
    expect(result.skippedAccounts[1].closeAuthority).toBeUndefined();
  });

  it("offers a delegated frozen account for close only (owner-approved 2026-09-25)", async () => {
    // The on-chain Revoke rejects frozen accounts (AccountFrozen in both
    // programs), so no Revoke is emitted for this account. The close
    // itself consults no frozen state, and a closed account leaves no
    // delegation behind, so the close-only path recovers the rent the
    // old skip left trapped.
    const delegated = tokenAccount(4, {
      delegate: pk(5).toBase58(),
      state: "frozen",
    });
    const { result } = await runScan([delegated]);
    expect(result.skippedAccounts).toHaveLength(0);
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.eligibleAccounts[0].needsRevoke).toBeUndefined();
    expect(result.eligibleAccounts[0].frozen).toBe(true);
    expect(result.eligibleAccounts[0].lamports).toBeGreaterThan(0);
  });

  it("marks a delegated Token-2022 account eligible with its program tag", async () => {
    const delegated = tokenAccount(4, { delegate: pk(5).toBase58() });
    const { result } = await runScan([], [delegated]);
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.eligibleAccounts[0].needsRevoke).toBe(true);
    expect(result.eligibleAccounts[0].program).toBe("token-2022");
  });

  it("leaves clean accounts without a revoke flag", async () => {
    const { result } = await runScan([tokenAccount(24)]);
    expect(result.eligibleAccounts[0].needsRevoke).toBeUndefined();
  });

  it("treats an omitted delegate field as NOT delegated (regression guard)", async () => {
    // Historical bug: the parsed RPC omits delegate entirely when there
    // is no delegation. A !== null check reads the missing field as
    // delegated and would skip every clean account in a wallet.
    const { result } = await runScan([tokenAccount(6)]);
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.skippedAccounts).toHaveLength(0);
  });

  it("also accepts an explicit null delegate", async () => {
    const { result } = await runScan([tokenAccount(7, { delegate: null })]);
    expect(result.eligibleAccounts).toHaveLength(1);
  });

  it("skips an account whose close authority belongs to another address", async () => {
    const foreignAuthority = tokenAccount(8, {
      closeAuthority: pk(9).toBase58(),
    });
    const { result } = await runScan([foreignAuthority]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe(
      "close authority belongs to another address"
    );
  });

  it("carries the foreign address on a close-authority skip, in both token programs", async () => {
    const splAuthority = pk(50).toBase58();
    const t22Authority = pk(51).toBase58();
    const { result } = await runScan(
      [tokenAccount(52, { closeAuthority: splAuthority })],
      [tokenAccount(53, { closeAuthority: t22Authority })]
    );
    expect(result.skippedAccounts).toHaveLength(2);
    const spl = result.skippedAccounts.find((s) => s.program === "spl");
    const t22 = result.skippedAccounts.find((s) => s.program === "token-2022");
    expect(spl?.cause).toBe("close-authority");
    expect(spl?.closeAuthority).toBe(splAuthority);
    expect(t22?.cause).toBe("close-authority");
    expect(t22?.closeAuthority).toBe(t22Authority);
  });

  it("treats an omitted closeAuthority field as owner-controlled", async () => {
    const { result } = await runScan([tokenAccount(10)]);
    expect(result.eligibleAccounts).toHaveLength(1);
    // No skip on that basis, so no closeAuthority field is recorded.
    expect(result.skippedAccounts).toHaveLength(0);
  });

  it("accepts an explicit closeAuthority equal to the owner", async () => {
    const { result } = await runScan([
      tokenAccount(11, { closeAuthority: OWNER.toBase58() }),
    ]);
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.skippedAccounts).toHaveLength(0);
  });

  it("skips a wrapped-SOL account", async () => {
    const wrapped = tokenAccount(12, { isNative: true });
    const { result } = await runScan([wrapped]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe("is a wrapped-SOL account");
  });

  it("offers a frozen empty account (the chain allows the owner to close it)", async () => {
    // Chain-verified 2026-09-19: a frozen empty account closes with err
    // null (devnet simulation against a real frozen account), and neither
    // CloseAccount path in either token program consults frozen state.
    // The freeze bit only guards transfers, burns, approvals, and revokes.
    const frozen = tokenAccount(13, { state: "frozen" });
    const { result } = await runScan([frozen]);
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.skippedAccounts).toHaveLength(0);
  });

  it("offers a frozen empty Token-2022 account too", async () => {
    const frozen = tokenAccount(13, { state: "frozen" });
    const { result } = await runScan([], [frozen]);
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.eligibleAccounts[0].program).toBe("token-2022");
  });

  it("keeps skipping frozen empty accounts whose close authority is foreign", async () => {
    const frozen = tokenAccount(13, {
      state: "frozen",
      closeAuthority: pk(9).toBase58(),
    });
    const { result } = await runScan([frozen]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe(
      "close authority belongs to another address"
    );
  });

  it("names the freeze authority when a frozen account holds a balance", async () => {
    // A frozen funded account is trapped for good: transfer rejects frozen
    // on both sides, burn rejects frozen, and close needs a zero balance,
    // so only the mint's freeze authority can release it (source-verified
    // in both token programs 2026-09-19). "Holds a token balance" would
    // read as solvable, which it is not, so the reason names the switch.
    const frozen = tokenAccount(13, {
      state: "frozen",
      tokenAmount: {
        amount: "1",
        decimals: 6,
        uiAmount: 0.000001,
        uiAmountString: "0.000001",
      },
    });
    const { result } = await runScan([frozen]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe(
      "is frozen by the token's freeze authority"
    );
  });

  it("gives the frozen funded reason on Token-2022 too", async () => {
    const frozen = tokenAccount(13, {
      state: "frozen",
      tokenAmount: {
        amount: "5",
        decimals: 6,
        uiAmount: 0.000005,
        uiAmountString: "0.000005",
      },
    });
    const { result } = await runScan([], [frozen]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe(
      "is frozen by the token's freeze authority"
    );
  });

  it("keeps the plain balance reason for accounts that are not frozen", async () => {
    const funded = tokenAccount(13, {
      tokenAmount: {
        amount: "1",
        decimals: 6,
        uiAmount: 0.000001,
        uiAmountString: "0.000001",
      },
    });
    const { result } = await runScan([funded]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe("holds a token balance");
  });

  it("still skips an uninitialized account, with an accurate reason", async () => {
    const uninitialized = tokenAccount(13, { state: "uninitialized" });
    const { result } = await runScan([uninitialized]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe("is not initialized");
  });

  it("scans both token programs and tags each account correctly", async () => {
    const { result, queried } = await runScan(
      [tokenAccount(14)],
      [tokenAccount(15, { state: "initialized" })]
    );
    expect(queried).toContain(TOKEN_PROGRAM_ID.toBase58());
    expect(queried).toContain(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(result.eligibleAccounts).toHaveLength(2);
    expect(result.eligibleAccounts.find((a) => a.program === "spl")).toBeTruthy();
    expect(
      result.eligibleAccounts.find((a) => a.program === "token-2022")
    ).toBeTruthy();
  });

  it("counts every account found and sums rent only over eligible ones", async () => {
    const funded = tokenAccount(16, {
      tokenAmount: {
        amount: "42",
        decimals: 6,
        uiAmount: 0.000042,
        uiAmountString: "0.000042",
      },
    });
    const clean = tokenAccount(17);
    const { result } = await runScan([funded, clean]);
    expect(result.totalAccounts).toBe(2);
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.recoverableLamports).toBe(2_039_280n);
  });

  it("reports unreadable RPC data as skipped instead of aborting the scan", async () => {
    // The scan asks for parsed encoding, but the shape that comes back
    // is provider-supplied. One malformed entry must neither abort the
    // scan nor vanish: it is reported as skipped with an honest reason,
    // its healthy neighbors still classify, and it still counts in the
    // total.
    const malformed = [
      brokenData(18, "not-json"),
      brokenData(19, { parsed: null }),
      brokenData(20, {}),
      brokenData(21, { parsed: {} }),
    ];
    const { result } = await runScan([tokenAccount(2), ...malformed]);

    expect(result.totalAccounts).toBe(5);
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.eligibleAccounts[0].pubkey).toBe(pk(2).toBase58());
    expect(result.recoverableLamports).toBe(2_039_280n);

    expect(result.skippedAccounts).toHaveLength(4);
    for (const skipped of result.skippedAccounts) {
      expect(skipped.reason).toBe(
        "response could not be read (malformed RPC data)"
      );
      expect(skipped.mint).toBe("unknown");
      expect(skipped.program).toBe("spl");
    }
    expect(result.skippedAccounts.map((s) => s.pubkey)).toEqual(
      malformed.map((m) => m.pubkey.toBase58())
    );
  });
});

describe("getClosableAccounts deep field validation", () => {
  // The parsed envelope can be intact while the numbers inside are
  // garbage. The scan must NEVER sanitize garbage into zero or another
  // default: an account whose balance or rent cannot be read as a whole
  // number cannot be proven safely closable, so it is skipped with the
  // honest malformed reason, its healthy neighbors still classify, and
  // nothing is counted toward the recoverable total.
  const MALFORMED = "response could not be read (malformed RPC data)";

  const cases = [
    {
      name: "a balance string that is not a number",
      seed: 30,
      overrides: {
        tokenAmount: {
          amount: "abc",
          decimals: 6,
          uiAmount: null,
          uiAmountString: "abc",
        },
      },
    },
    {
      name: "a balance field missing entirely",
      seed: 31,
      overrides: {
        tokenAmount: { decimals: 6, uiAmount: null, uiAmountString: "0" },
      } as Record<string, unknown>,
    },
    {
      name: "a fractional balance string",
      seed: 32,
      overrides: {
        tokenAmount: {
          amount: "1.5",
          decimals: 6,
          uiAmount: null,
          uiAmountString: "1.5",
        },
      },
    },
    {
      // The state field must be one of the three literals: a garbage or
      // missing state would otherwise fall through check #5 as "not
      // uninitialized" and classify as eligible (audit 2026-09-29, F2).
      name: "a state outside the three literals",
      seed: 33,
      overrides: { state: "available" },
    },
    {
      name: "a state field missing entirely",
      seed: 34,
      overrides: { state: undefined },
    },
  ];

  for (const { name, seed, overrides } of cases) {
    it(`skips an account with ${name}, without defaulting it to zero`, async () => {
      const garbage = tokenAccount(seed, overrides);
      const { result } = await runScan([tokenAccount(2), garbage]);

      expect(result.totalAccounts).toBe(2);
      expect(result.eligibleAccounts).toHaveLength(1);
      expect(result.eligibleAccounts[0].pubkey).toBe(pk(2).toBase58());
      expect(result.recoverableLamports).toBe(2_039_280n);

      expect(result.skippedAccounts).toHaveLength(1);
      const skipped = result.skippedAccounts[0];
      expect(skipped.pubkey).toBe(pk(seed).toBase58());
      expect(skipped.reason).toBe(MALFORMED);
      expect(skipped.mint).toBe(pk(seed + 100).toBase58());
    });
  }

  const lamportsCases = [
    { name: "rent that is fractional", seed: 40, lamports: 3.5 },
    { name: "rent that is missing", seed: 41, lamports: undefined },
    { name: "negative rent", seed: 42, lamports: -100 },
  ];

  for (const { name, seed, lamports } of lamportsCases) {
    it(`skips an account with ${name}, without defaulting it to zero`, async () => {
      const garbage = tokenAccount(seed, {}, { lamports });
      const { result } = await runScan([tokenAccount(2), garbage]);

      expect(result.totalAccounts).toBe(2);
      expect(result.eligibleAccounts).toHaveLength(1);
      expect(result.eligibleAccounts[0].pubkey).toBe(pk(2).toBase58());
      expect(result.recoverableLamports).toBe(2_039_280n);

      expect(result.skippedAccounts).toHaveLength(1);
      const skipped = result.skippedAccounts[0];
      expect(skipped.pubkey).toBe(pk(seed).toBase58());
      expect(skipped.reason).toBe(MALFORMED);
      expect(skipped.mint).toBe(pk(seed + 100).toBase58());
    });
  }
});

/* ------------------------------------------------------------------ */
/* The Token-2022 extension close-blocker check (scan level)           */
/* ------------------------------------------------------------------ */

/** A Token-2022 fixture in the parsed shape (the parsed owner field is
 * display evidence only; the parsed scan never checks it). */
function t22Parsed(seed: number, overrides: Record<string, unknown> = {}) {
  return tokenAccount(seed, overrides, {
    owner: TOKEN_2022_PROGRAM_ID.toBase58(),
  });
}

/** Raw Token-2022 account data for the extension read: 165-byte base,
 * the account-type byte 2 (AccountType.Account; Mint is 1), then the
 * TLV entries (u16 LE type, u16 LE length, value) exactly as the
 * program serializes them. */
function rawT22(entries: Array<[number, Buffer]>): Buffer {
  const chunks = entries.map(([type, value]) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(value.length, 2);
    return Buffer.concat([head, value]);
  });
  return Buffer.concat([Buffer.alloc(165), Buffer.from([2]), ...chunks]);
}

function u64le(amount: bigint): Buffer {
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(amount);
  return value;
}

/** A full-size ConfidentialTransferAccount value with one non-zero byte
 * at the given offset (a non-zero ciphertext). */
function confidentialValue(nonZeroOffset: number | null): Buffer {
  const value = Buffer.alloc(331);
  if (nonZeroOffset !== null) value[nonZeroOffset] = 1;
  return value;
}

describe("getClosableAccounts Token-2022 close-blocker check", () => {
  it("keeps a Token-2022 account with only ImmutableOwner eligible (over-exclusion guard)", async () => {
    const seed = 20;
    const { result, rawCalls } = await runScan(
      [],
      [t22Parsed(seed)],
      {
        [pk(seed).toBase58()]: {
          owner: TOKEN_2022_PROGRAM_ID,
          data: rawT22([[7, Buffer.alloc(0)]]),
        },
      }
    );
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.eligibleAccounts[0].program).toBe("token-2022");
    expect(result.recoverableLamports).toBe(2_039_280n);
    expect(result.skippedAccounts).toHaveLength(0);
    // One close-blocker read, then the widened mint read for the
    // account's mint (mint/freeze authority display spec).
    expect(rawCalls).toEqual([1, 1]);
  });

  it("skips a withheld-fee account with the approved reason and evidence", async () => {
    const seed = 21;
    const { result } = await runScan(
      [],
      [t22Parsed(seed)],
      {
        [pk(seed).toBase58()]: {
          owner: TOKEN_2022_PROGRAM_ID,
          data: rawT22([[2, u64le(500n)]]),
        },
      }
    );
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.recoverableLamports).toBe(0n);
    expect(result.skippedAccounts).toHaveLength(1);
    const skipped = result.skippedAccounts[0];
    expect(skipped.cause).toBe("close-blocked-extension");
    expect(skipped.extensionBlocker).toBe("withheld-fee");
    expect(skipped.reason).toBe(
      "holds a withheld transfer fee only the mint's fee authority can release"
    );
    expect(skipped.program).toBe("token-2022");
    expect(skipped.nativeStatus).toBe("non-native");
    expect(skipped.lamports).toBe(2_039_280);
  });

  it("skips an encrypted-balance account (confidential pending) with the approved reason", async () => {
    const seed = 22;
    const { result } = await runScan(
      [],
      [t22Parsed(seed)],
      {
        [pk(seed).toBase58()]: {
          owner: TOKEN_2022_PROGRAM_ID,
          data: rawT22([[5, confidentialValue(33)]]),
        },
      }
    );
    expect(result.skippedAccounts).toHaveLength(1);
    expect(result.skippedAccounts[0].cause).toBe("close-blocked-extension");
    expect(result.skippedAccounts[0].extensionBlocker).toBe(
      "confidential-balance"
    );
    expect(result.skippedAccounts[0].reason).toBe(
      "holds an encrypted balance in a privacy extension that only a supporting wallet can release"
    );
  });

  it("skips a vanished raw read with the unreadable-extensions cause", async () => {
    const seed = 23;
    const { result } = await runScan(
      [],
      [t22Parsed(seed)],
      { [pk(seed).toBase58()]: null }
    );
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts).toHaveLength(1);
    expect(result.skippedAccounts[0].cause).toBe("extension-unreadable");
    expect(result.skippedAccounts[0].reason).toBe(
      "its extensions could not be read"
    );
    expect(result.skippedAccounts[0].nativeStatus).toBe("non-native");
  });

  it("skips a malformed extension list with the unreadable-extensions cause", async () => {
    const seed = 24;
    const { result } = await runScan(
      [],
      [t22Parsed(seed)],
      {
        [pk(seed).toBase58()]: {
          owner: TOKEN_2022_PROGRAM_ID,
          data: rawT22([[5, Buffer.alloc(10)]]),
        },
      }
    );
    expect(result.skippedAccounts).toHaveLength(1);
    expect(result.skippedAccounts[0].cause).toBe("extension-unreadable");
    expect(result.recoverableLamports).toBe(0n);
  });

  it("keeps a classic neighbor eligible and counts only its rent", async () => {
    const seed = 25;
    const { result, rawCalls } = await runScan(
      [tokenAccount(26)],
      [t22Parsed(seed)],
      {
        [pk(seed).toBase58()]: {
          owner: TOKEN_2022_PROGRAM_ID,
          data: rawT22([[2, u64le(1n)]]),
        },
      }
    );
    expect(result.eligibleAccounts).toHaveLength(1);
    expect(result.eligibleAccounts[0].program).toBe("spl");
    expect(result.recoverableLamports).toBe(2_039_280n);
    expect(result.skippedAccounts).toHaveLength(1);
    // The close-blocker read covers only the Token-2022 candidate; the
    // widened mint read then covers both accounts' mints (display spec).
    expect(rawCalls).toEqual([1, 2]);
  });

  it("carries the delegated flag onto a blocked skip", async () => {
    const seed = 27;
    const { result } = await runScan(
      [],
      [t22Parsed(seed, { delegate: pk(28).toBase58() })],
      {
        [pk(seed).toBase58()]: {
          owner: TOKEN_2022_PROGRAM_ID,
          data: rawT22([[2, u64le(1n)]]),
        },
      }
    );
    expect(result.skippedAccounts).toHaveLength(1);
    expect(result.skippedAccounts[0].delegated).toBe(true);
  });

  it("issues no close-blocker read when only classic accounts are eligible, and reads their mint", async () => {
    const { result, rawCalls } = await runScan([tokenAccount(30)]);
    expect(result.eligibleAccounts).toHaveLength(1);
    // No close-blocker read (classic), then the widened mint read of
    // the account's mint (mint/freeze authority display spec).
    expect(rawCalls).toEqual([1]);
  });

  it("chunks the raw read at 100 accounts", async () => {
    const accounts = Array.from({ length: 150 }, (_, i) =>
      t22Parsed(100 + i)
    );
    const { result, rawCalls } = await runScan([], accounts);
    expect(result.eligibleAccounts).toHaveLength(150);
    // The close-blocker read chunks at 100, then the widened mint read
    // chunks the 150 distinct mints the same way (display spec).
    expect(rawCalls).toEqual([100, 50, 100, 50]);
  });
});
