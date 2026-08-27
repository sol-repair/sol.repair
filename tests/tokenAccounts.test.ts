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
 *  override a single field each so every test isolates one rule. */
function tokenAccount(seed: number, overrides: Record<string, unknown> = {}) {
  return {
    pubkey: pk(seed),
    account: {
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM_ID.toBase58(),
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
});
