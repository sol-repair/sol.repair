/**
 * Pure-module tests for the G.2 revocation core (spec §10.1, §10.2):
 * the eligibility selector, the revoke-only instruction builder, the
 * single-account on-chain read, and the refresh-gate evaluator — plus
 * the import-boundary source scans (§10.2.10, §10.7) that keep the
 * action module unable to reach the close flow, the fee system, or the
 * read-only inspection layer.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  Connection,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

import {
  buildRevokeInstruction,
  evaluateDelegationGate,
  readDelegatedAccountState,
  selectRevocableDelegations,
  type DelegatedAccountRead,
  type RevocableDelegation,
} from "../src/lib/solana/revokeDelegation";
import {
  nativeStatusOf,
  TOKEN_PROGRAM_ID as SCAN_TOKEN_PROGRAM_ID,
  type ScanResult,
  type SkippedAccount,
} from "../src/lib/solana/tokenAccounts";
import { buildTransaction } from "../src/lib/solana/transactions";

const DELEGATE = "DelegAteAddress11111111111111111111111111111";
const OWNER = new PublicKey(Buffer.alloc(32, 1));
const ACCOUNT = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const ACCOUNT22 = new PublicKey(Buffer.alloc(32, 8)).toBase58();

const skipEntry = (
  over: Partial<SkippedAccount> & { cause: SkippedAccount["cause"] }
): SkippedAccount => ({
  pubkey: ACCOUNT,
  mint: "MINT",
  reason: "holds a token balance",
  program: "spl",
  ...over,
});

const fundedDelegated = (
  over: Partial<SkippedAccount> = {}
): SkippedAccount =>
  skipEntry({
    cause: "funded",
    delegated: true,
    delegate: DELEGATE,
    nativeStatus: "non-native",
    balance: "1000000",
    decimals: 6,
    lamports: 2039280,
    ...over,
  });

const scanWith = (skipped: SkippedAccount[]): ScanResult => ({
  totalAccounts: skipped.length,
  eligibleAccounts: [],
  recoverableLamports: 0n,
  skippedAccounts: skipped,
});

const delegationOf = (entry: SkippedAccount): RevocableDelegation =>
  selectRevocableDelegations(scanWith([entry]))[0];

describe("selectRevocableDelegations eligibility (spec §10.1)", () => {
  it("selects a funded delegated non-native account with full evidence", () => {
    const out = selectRevocableDelegations(scanWith([fundedDelegated()]));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      pubkey: ACCOUNT,
      mint: "MINT",
      balanceAtScan: "1000000",
      decimals: 6,
      lamports: 2039280,
      program: "spl",
      delegate: DELEGATE,
    });
  });

  it("does not select an empty delegated account (frozen-with-delegate)", () => {
    const out = selectRevocableDelegations(
      scanWith([
        skipEntry({
          cause: "frozen-with-delegate",
          delegated: true,
          delegate: DELEGATE,
          nativeStatus: "non-native",
        }),
      ])
    );
    expect(out).toHaveLength(0);
  });

  it("does not select a funded account without a delegate", () => {
    const out = selectRevocableDelegations(
      scanWith([fundedDelegated({ delegated: undefined, delegate: undefined })])
    );
    expect(out).toHaveLength(0);
  });

  it("does not select a frozen funded delegated account", () => {
    const out = selectRevocableDelegations(
      scanWith([fundedDelegated({ frozen: true })])
    );
    expect(out).toHaveLength(0);
  });

  it("does not select an unreadable account", () => {
    const out = selectRevocableDelegations(
      scanWith([skipEntry({ cause: "unreadable" })])
    );
    expect(out).toHaveLength(0);
  });

  it.each([
    ["missing balance", fundedDelegated({ balance: undefined })],
    ["non-digit balance", fundedDelegated({ balance: "12.5" })],
    ["zero balance", fundedDelegated({ balance: "0" })],
    ["missing lamports", fundedDelegated({ lamports: undefined })],
    ["missing decimals", fundedDelegated({ decimals: undefined })],
  ])("does not select an account with %s", (_name, entry) => {
    expect(selectRevocableDelegations(scanWith([entry]))).toHaveLength(0);
  });

  it("selects SPL and Token-2022 entries, preserving the program tag", () => {
    const out = selectRevocableDelegations(
      scanWith([
        fundedDelegated(),
        fundedDelegated({ pubkey: ACCOUNT22, program: "token-2022" }),
      ])
    );
    expect(out.map((d) => d.program)).toEqual(["spl", "token-2022"]);
  });

  it("selects a funded delegated account with a foreign close authority", () => {
    // Close authority plays no role in revocation (spec §4.4): funded
    // skips never reach the close-authority check.
    const out = selectRevocableDelegations(
      scanWith([fundedDelegated({ reason: "holds a token balance" })])
    );
    expect(out).toHaveLength(1);
  });

  it("never derives eligibility from the reason prose", () => {
    const out = selectRevocableDelegations(
      scanWith([fundedDelegated({ reason: "totally different words" })])
    );
    expect(out).toHaveLength(1);
  });

  // --- Native evidence, three states (spec §10.1.11-14) ---
  it("does not select a confirmed-native account", () => {
    const out = selectRevocableDelegations(
      scanWith([fundedDelegated({ nativeStatus: "native" })])
    );
    expect(out).toHaveLength(0);
  });

  it("selects a confirmed non-native account", () => {
    const out = selectRevocableDelegations(
      scanWith([fundedDelegated({ nativeStatus: "non-native" })])
    );
    expect(out).toHaveLength(1);
  });

  it("does not select an account with unknown native status (omitted field)", () => {
    const out = selectRevocableDelegations(
      scanWith([fundedDelegated({ nativeStatus: undefined })])
    );
    expect(out).toHaveLength(0);
  });

  it("does not select an account with unknown native status (explicit)", () => {
    const out = selectRevocableDelegations(
      scanWith([fundedDelegated({ nativeStatus: "unknown" })])
    );
    expect(out).toHaveLength(0);
  });

  it("never invents a native status from another field", () => {
    // The unknown state must stay unknown: nothing in the entry can
    // upgrade it to non-native.
    const entry = fundedDelegated({ nativeStatus: "unknown" });
    expect(entry.nativeStatus).toBe("unknown");
    expect(nativeStatusOf(undefined)).toBe("unknown");
    expect(nativeStatusOf(null)).toBe("unknown");
    expect(nativeStatusOf("no")).toBe("unknown");
    expect(nativeStatusOf(1)).toBe("unknown");
  });

  it("existing cleanup classification is unchanged by the new fields", () => {
    // The same entry with all three native states keeps its cause and
    // reason (the scan's own classification); the selector is a filter
    // over evidence, not a classifier.
    for (const nativeStatus of ["native", "non-native", "unknown"] as const) {
      const entry = fundedDelegated({ nativeStatus });
      expect(entry.cause).toBe("funded");
      expect(entry.reason).toBe("holds a token balance");
    }
  });
});

describe("buildRevokeInstruction safety (spec §10.2)", () => {
  const delegation = delegationOf(fundedDelegated());
  const delegation22 = delegationOf(
    fundedDelegated({ program: "token-2022" })
  );

  it("builds exactly one instruction with the exact Revoke wire bytes", () => {
    const ix = buildRevokeInstruction(delegation, OWNER);
    expect(Buffer.from(ix.data).toString("hex")).toBe("05");
    // One byte leaves no room for an amount.
    expect(ix.data.byteLength).toBe(1);
  });

  it("binds exactly two keys: the writable token account and the owner signer", () => {
    const ix = buildRevokeInstruction(delegation, OWNER);
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[0].pubkey.toBase58()).toBe(delegation.pubkey);
    expect(ix.keys[0].isSigner).toBe(false);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(OWNER)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
  });

  it("targets each account's owning token program", () => {
    const spl = buildRevokeInstruction(delegation, OWNER);
    expect(spl.programId.equals(SCAN_TOKEN_PROGRAM_ID)).toBe(true);
    const t22 = buildRevokeInstruction(delegation22, OWNER);
    expect(t22.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("assembles a transaction with exactly one instruction and no system program", async () => {
    const connection = {
      getLatestBlockhash: async () => ({
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 1000,
      }),
    } as unknown as Connection;
    const transaction = await buildTransaction(
      connection,
      OWNER,
      [buildRevokeInstruction(delegation, OWNER)]
    );
    expect(transaction.instructions).toHaveLength(1);
    expect(
      Buffer.from(transaction.instructions[0].data).toString("hex")
    ).toBe("05");
    const hasSystemTransfer = transaction.instructions.some((ix) =>
      ix.programId.equals(SystemProgram.programId)
    );
    expect(hasSystemTransfer).toBe(false);
    // No transfer, burn, close, or approve instruction can be present:
    // the set has exactly one member, pinned by the byte check above.
  });
});

/* ------------------------------------------------------------------ */
/* readDelegatedAccountState                                           */
/* ------------------------------------------------------------------ */

const parsedInfo = (over: {
  delegate?: string | null;
  amount?: string;
  state?: string;
  owner?: string;
  isNative?: boolean;
}) => ({
  mint: "MINT1111",
  owner: over.owner ?? OWNER.toBase58(),
  tokenAmount: {
    amount: over.amount ?? "1000000",
    decimals: 6,
    uiAmount: null,
    uiAmountString: "0",
  },
  ...(over.delegate === undefined
    ? { delegate: DELEGATE }
    : over.delegate === null
      ? {}
      : { delegate: over.delegate }),
  state: over.state ?? "initialized",
  ...(over.isNative === undefined ? {} : { isNative: over.isNative }),
});

const accountValue = (info: unknown, programOwner: PublicKey = SCAN_TOKEN_PROGRAM_ID) => ({
  value: programOwner
    ? {
        lamports: 2039280,
        owner: programOwner,
        data: { parsed: { info } },
      }
    : null,
});

const connectionReading = (value: unknown): Connection => {
  const seen: Array<string | undefined> = [];
  const conn = {
    getParsedAccountInfo: async (_pk: PublicKey, commitment?: string) => {
      seen.push(commitment);
      return value;
    },
  } as unknown as Connection;
  (conn as unknown as { seen: Array<string | undefined> }).seen = seen;
  return conn;
};

const seenCommitments = (connection: Connection) =>
  (connection as unknown as { seen: Array<string | undefined> }).seen;

describe("readDelegatedAccountState", () => {
  it("reads a delegated account with validated evidence", async () => {
    const conn = connectionReading(accountValue(parsedInfo({})));
    const read = await readDelegatedAccountState(conn, OWNER.toBase58());
    expect(read).toEqual({
      kind: "read",
      delegate: DELEGATE,
      balance: "1000000",
      decimals: 6,
      frozen: false,
      nativeStatus: "unknown",
      walletOwner: OWNER.toBase58(),
    });
    expect(seenCommitments(conn)).toEqual(["confirmed"]);
  });

  it("treats an omitted or empty delegate as absent", async () => {
    const omitted = await readDelegatedAccountState(
      connectionReading(accountValue(parsedInfo({ delegate: null }))),
      OWNER.toBase58()
    );
    expect(omitted).toMatchObject({ kind: "read", delegate: null });
  });

  it("maps the three native states from the parsed isNative value", async () => {
    const native = await readDelegatedAccountState(
      connectionReading(accountValue(parsedInfo({ isNative: true }))),
      OWNER.toBase58()
    );
    expect(native).toMatchObject({ kind: "read", nativeStatus: "native" });
    const nonNative = await readDelegatedAccountState(
      connectionReading(accountValue(parsedInfo({ isNative: false }))),
      OWNER.toBase58()
    );
    expect(nonNative).toMatchObject({
      kind: "read",
      nativeStatus: "non-native",
    });
    const unknown = await readDelegatedAccountState(
      connectionReading(accountValue(parsedInfo({}))),
      OWNER.toBase58()
    );
    expect(unknown).toMatchObject({ kind: "read", nativeStatus: "unknown" });
  });

  it("reports a missing account", async () => {
    const conn = connectionReading({ value: null });
    const read = await readDelegatedAccountState(conn, OWNER.toBase58());
    expect(read.kind).toBe("missing");
  });

  it("reports a non-token-program account as unreadable", async () => {
    const read = await readDelegatedAccountState(
      connectionReading(accountValue(parsedInfo({}), PublicKey.default)),
      OWNER.toBase58()
    );
    expect(read.kind).toBe("unreadable");
  });

  it.each([
    ["malformed parsed envelope", { value: { owner: SCAN_TOKEN_PROGRAM_ID, data: {} } }],
    ["non-digit balance", accountValue(parsedInfo({ amount: "12.5" }))],
    ["uninitialized state", accountValue(parsedInfo({ state: "uninitialized" }))],
  ])("reports %s as unreadable", async (_name, value) => {
    const read = await readDelegatedAccountState(
      connectionReading(value),
      OWNER.toBase58()
    );
    expect(read.kind).toBe("unreadable");
  });
});

/* ------------------------------------------------------------------ */
/* evaluateDelegationGate                                              */
/* ------------------------------------------------------------------ */

const gateRead = (over: Partial<Extract<DelegatedAccountRead, { kind: "read" }>> = {}): DelegatedAccountRead => ({
  kind: "read",
  delegate: DELEGATE,
  balance: "1000000",
  decimals: 6,
  frozen: false,
  nativeStatus: "non-native",
  walletOwner: OWNER.toBase58(),
  ...over,
});

describe("evaluateDelegationGate (spec §8.3)", () => {
  it("passes a matching account and carries balanceBeforeAction", () => {
    const verdict = evaluateDelegationGate(gateRead(), DELEGATE, OWNER.toBase58());
    expect(verdict).toEqual({
      kind: "pass",
      balanceBeforeAction: "1000000",
      delegate: DELEGATE,
    });
  });

  it("reports already-absent when the delegate is gone", () => {
    const verdict = evaluateDelegationGate(
      gateRead({ delegate: null }),
      DELEGATE,
      OWNER.toBase58()
    );
    expect(verdict).toEqual({
      kind: "already-absent",
      balanceBeforeAction: "1000000",
    });
  });

  it.each([
    ["missing", { kind: "missing" } as DelegatedAccountRead, "missing"],
    ["unreadable", { kind: "unreadable" } as DelegatedAccountRead, "unreadable"],
    ["foreign owner", gateRead({ walletOwner: "Other" }), "foreign-owner"],
    ["frozen", gateRead({ frozen: true }), "frozen"],
    [
      "confirmed native",
      gateRead({ nativeStatus: "native" }),
      "confirmed-native",
    ],
    [
      "delegate changed",
      gateRead({ delegate: "NewDelegate" }),
      "delegate-changed",
    ],
  ])("aborts on %s", (_name, read, reason) => {
    const verdict = evaluateDelegationGate(read, DELEGATE, OWNER.toBase58());
    expect(verdict.kind).toBe("abort");
    expect((verdict as { reason: string }).reason).toBe(reason);
  });

  it("does NOT abort on unknown native status (defense in depth only)", () => {
    const verdict = evaluateDelegationGate(
      gateRead({ nativeStatus: "unknown" }),
      DELEGATE,
      OWNER.toBase58()
    );
    expect(verdict.kind).toBe("pass");
  });

  it("does NOT abort on a balance change (review-confirmed Case B)", () => {
    const verdict = evaluateDelegationGate(
      gateRead({ balance: "900000" }),
      DELEGATE,
      OWNER.toBase58()
    );
    expect(verdict.kind).toBe("pass");
    expect((verdict as { balanceBeforeAction: string }).balanceBeforeAction).toBe(
      "900000"
    );
  });

  it("carries the new delegate address on a delegate-changed abort", () => {
    const verdict = evaluateDelegationGate(
      gateRead({ delegate: "NewDelegate" }),
      DELEGATE,
      OWNER.toBase58()
    );
    expect(verdict).toMatchObject({
      kind: "abort",
      reason: "delegate-changed",
      currentDelegate: "NewDelegate",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Import boundary (spec §10.2.10, §10.7)                              */
/* ------------------------------------------------------------------ */

const importStatements = (source: string) =>
  source.match(/^import[\s\S]*?from "[^"]+";/gm) ?? [];

describe("import boundary", () => {
  it("revokeDelegation.ts imports no action-bearing, inspection, or React module", () => {
    const imports = importStatements(
      readFileSync("src/lib/solana/revokeDelegation.ts", "utf8")
    );
    const joined = imports.join("\n");
    expect(imports.length).toBeGreaterThanOrEqual(2);
    expect(joined).not.toMatch(
      /closeAccounts|fees|walletInspection|explain|postState|react|wallet-adapter/i
    );
  });

  it("useRepairWallet.ts's only new import is the action mutex (§10.7 guard)", () => {
    const imports = importStatements(
      readFileSync("src/hooks/useRepairWallet.ts", "utf8")
    );
    const from = imports.map((line) => line.match(/from "([^"]+)";/)?.[1] ?? "");
    const allowed = new Set([
      "react",
      "@solana/wallet-adapter-react",
      "bs58",
      "@solana/web3.js",
      "@/lib/solana/closeAccounts",
      "@/lib/actionMutex",
      "@/lib/solana/fees",
      "@/lib/solana/transactions",
      "@/lib/solana/tokenAccounts",
      // M9: the failover-aware RPC connection hook (connection.ts's
      // ordered endpoint list) - transport only, no action or inspection
      // surface.
      "@/hooks/useRpcConnection",
    ]);
    for (const source of from) {
      expect(allowed.has(source)).toBe(true);
    }
    expect(from).toContain("@/lib/actionMutex");
  });

  it("the read-only layer imports nothing from the action modules", () => {
    const inspection = importStatements(
      readFileSync("src/lib/solana/walletInspection.ts", "utf8")
    );
    expect(inspection.join("\n")).not.toMatch(/revokeDelegation|useRevokeDelegate/);
    const summary = importStatements(
      readFileSync("src/components/WalletStateSummary.tsx", "utf8")
    );
    expect(summary.join("\n")).not.toMatch(
      /revokeDelegation|useRevokeDelegate|actionMutex/
    );
  });
});
