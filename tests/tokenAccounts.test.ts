/**
 * Fixture tests for the five eligibility checks in tokenAccounts.ts.
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
 *  program id, exactly as the scan consumes it. */
function mockConnection(
  byProgram: Record<string, ReturnType<typeof tokenAccount>[]>
) {
  const queried: string[] = [];
  const connection = {
    async getParsedTokenAccountsByOwner(
      _owner: PublicKey,
      filter: { programId: PublicKey }
    ) {
      queried.push(filter.programId.toBase58());
      return { value: byProgram[filter.programId.toBase58()] ?? [] };
    },
  };
  return { connection: connection as unknown as Connection, queried };
}

async function runScan(
  splAccounts: ReturnType<typeof tokenAccount>[] = [],
  token22Accounts: ReturnType<typeof tokenAccount>[] = []
) {
  const { connection, queried } = mockConnection({
    [TOKEN_PROGRAM_ID.toBase58()]: splAccounts,
    [TOKEN_2022_PROGRAM_ID.toBase58()]: token22Accounts,
  });
  const result = await getClosableAccounts(connection, OWNER);
  return { result, queried };
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

  it("skips an actively delegated account", async () => {
    const delegated = tokenAccount(4, {
      delegate: pk(5).toBase58(),
    });
    const { result } = await runScan([delegated]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe("has an active delegation");
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

  it("treats an omitted closeAuthority field as owner-controlled", async () => {
    const { result } = await runScan([tokenAccount(10)]);
    expect(result.eligibleAccounts).toHaveLength(1);
  });

  it("accepts an explicit closeAuthority equal to the owner", async () => {
    const { result } = await runScan([
      tokenAccount(11, { closeAuthority: OWNER.toBase58() }),
    ]);
    expect(result.eligibleAccounts).toHaveLength(1);
  });

  it("skips a wrapped-SOL account", async () => {
    const wrapped = tokenAccount(12, { isNative: true });
    const { result } = await runScan([wrapped]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe("is a wrapped-SOL account");
  });

  it("skips a frozen account", async () => {
    const frozen = tokenAccount(13, { state: "frozen" });
    const { result } = await runScan([frozen]);
    expect(result.eligibleAccounts).toHaveLength(0);
    expect(result.skippedAccounts[0].reason).toBe(
      "is frozen (not initialized)"
    );
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

describe("getClosableAccounts deep numerical fields", () => {
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
