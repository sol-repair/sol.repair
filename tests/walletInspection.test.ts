/**
 * Pure summarizer tests for the wallet state inspection layer.
 *
 * The summarizer consumes a completed ScanResult and groups accounts into
 * finding kinds. Finding kinds are TAGS, NOT PARTITIONS: one account can
 * belong to several kinds (funded + delegated, empty + frozen), so
 * sum(byKind) may legitimately exceed totalAccounts. The invariant that
 * matters is "no account is silently lost", and these tests pin both that
 * and the exact co-occurrence rules.
 */

import { describe, expect, it } from "vitest";

import {
  FINDING_KINDS,
  summarizeWalletState,
  type FindingKind,
} from "@/lib/solana/walletInspection";
import type {
  ClosableAccount,
  ScanResult,
  SkippedAccount,
} from "@/lib/solana/tokenAccounts";

const account = (over: Partial<ClosableAccount> = {}): ClosableAccount => ({
  pubkey: "ACCT",
  mint: "MINT",
  lamports: 2039280,
  program: "spl",
  ...over,
});

const skip = (
  over: Partial<SkippedAccount> & { cause: SkippedAccount["cause"] }
): SkippedAccount => ({
  pubkey: "SKIP",
  mint: "MINT",
  reason: "reason text",
  program: "spl",
  ...over,
});

const scan = (over: Partial<ScanResult> = {}): ScanResult => ({
  totalAccounts: 0,
  eligibleAccounts: [],
  recoverableLamports: 0n,
  skippedAccounts: [],
  ...over,
});

describe("summarizeWalletState", () => {
  it("returns an all-zero summary for an empty scan", () => {
    const summary = summarizeWalletState(scan());
    for (const kind of FINDING_KINDS) {
      expect(summary.totals.byKind[kind]).toBe(0);
    }
    expect(summary.totals.accounts).toBe(0);
    expect(summary.rentLamports.recoverable).toBe(0n);
    expect(summary.rentLamports.inFundedAccounts).toBe(0n);
    expect(summary.incomplete).toBe(false);
    expect(summary.checked.programs).toEqual(["spl", "token-2022"]);
    expect(summary.checked.commitment).toBe("finalized");
  });

  it("exposes exactly the locked finding kinds, none added", () => {
    const summary = summarizeWalletState(scan());
    expect(Object.keys(summary.totals.byKind).sort()).toEqual(
      [...FINDING_KINDS].sort()
    );
  });

  it("counts a single empty closable account with its rent", () => {
    const result = scan({
      totalAccounts: 1,
      eligibleAccounts: [account()],
      recoverableLamports: 2039280n,
    });
    const summary = summarizeWalletState(result);
    expect(summary.totals.byKind["empty-closable"]).toBe(1);
    expect(summary.totals.byKind["funded-holding"]).toBe(0);
    expect(summary.totals.byKind["active-delegation"]).toBe(0);
    expect(summary.rentLamports.recoverable).toBe(2039280n);
  });

  it("counts a single funded account with exact evidence and no judgment", () => {
    const funded = skip({
      cause: "funded",
      reason: "holds a token balance",
      balance: "1000000",
      decimals: 6,
      lamports: 12345,
    });
    const summary = summarizeWalletState(
      scan({ totalAccounts: 1, skippedAccounts: [funded] })
    );
    expect(summary.totals.byKind["funded-holding"]).toBe(1);
    expect(summary.rentLamports.inFundedAccounts).toBe(12345n);
    expect(summary.totals.byKind["active-delegation"]).toBe(0);
    // Observable state only: no severity/score/risk-style field may exist.
    expect(Object.keys(summary)).toEqual([
      "checked",
      "totals",
      "rentLamports",
      "groups",
      "incomplete",
    ]);
    expect(typeof summary.rentLamports.recoverable).toBe("bigint");
    expect(typeof summary.rentLamports.inFundedAccounts).toBe("bigint");
  });

  it("counts a funded delegated account in BOTH kinds (co-occurrence)", () => {
    const fundedDelegated = skip({
      cause: "funded",
      reason: "holds a token balance",
      balance: "7",
      decimals: 6,
      lamports: 200,
      delegated: true,
    });
    const summary = summarizeWalletState(
      scan({ totalAccounts: 1, skippedAccounts: [fundedDelegated] })
    );
    expect(summary.totals.byKind["funded-holding"]).toBe(1);
    expect(summary.totals.byKind["active-delegation"]).toBe(1);
  });

  it("counts a frozen funded account in BOTH kinds (co-occurrence)", () => {
    const frozenFunded = skip({
      cause: "funded",
      reason: "is frozen by the token's freeze authority",
      balance: "5",
      decimals: 6,
      lamports: 300,
      frozen: true,
    });
    const summary = summarizeWalletState(
      scan({ totalAccounts: 1, skippedAccounts: [frozenFunded] })
    );
    expect(summary.totals.byKind["funded-holding"]).toBe(1);
    expect(summary.totals.byKind["frozen"]).toBe(1);
  });

  it("counts a frozen EMPTY eligible account in BOTH kinds (existing eligibility kept)", () => {
    const frozenEmpty = account({ frozen: true });
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 1,
        eligibleAccounts: [frozenEmpty],
        recoverableLamports: 2039280n,
      })
    );
    expect(summary.totals.byKind["empty-closable"]).toBe(1);
    expect(summary.totals.byKind["frozen"]).toBe(1);
  });

  it("counts a delegated EMPTY eligible account in BOTH kinds", () => {
    const delegatedEmpty = account({ needsRevoke: true });
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 1,
        eligibleAccounts: [delegatedEmpty],
        recoverableLamports: 2039280n,
      })
    );
    expect(summary.totals.byKind["empty-closable"]).toBe(1);
    expect(summary.totals.byKind["active-delegation"]).toBe(1);
  });

  it("maps each skipped cause to its finding kind", () => {
    const cases: Array<[SkippedAccount, FindingKind]> = [
      [skip({ cause: "close-authority" }), "foreign-close-authority"],
      [skip({ cause: "wrapped-sol" }), "wrapped-sol"],
      [skip({ cause: "uninitialized" }), "uninitialized"],
    ];
    for (const [entry, kind] of cases) {
      const summary = summarizeWalletState(
        scan({ totalAccounts: 1, skippedAccounts: [entry] })
      );
      expect(summary.totals.byKind[kind]).toBe(1);
      expect(summary.incomplete).toBe(false);
    }
  });

  it("counts a frozen delegated empty account in BOTH kinds", () => {
    const frozenDelegated = skip({
      cause: "frozen-with-delegate",
      reason: "is frozen with an active delegate",
      delegated: true,
    });
    const summary = summarizeWalletState(
      scan({ totalAccounts: 1, skippedAccounts: [frozenDelegated] })
    );
    expect(summary.totals.byKind["frozen"]).toBe(1);
    expect(summary.totals.byKind["active-delegation"]).toBe(1);
    expect(summary.totals.byKind["funded-holding"]).toBe(0);
  });

  it("counts unreadable accounts and flags the summary incomplete", () => {
    const unreadable = skip({
      cause: "unreadable",
      reason: "response could not be read (malformed RPC data)",
    });
    const summary = summarizeWalletState(
      scan({ totalAccounts: 1, skippedAccounts: [unreadable] })
    );
    expect(summary.totals.byKind["unreadable"]).toBe(1);
    expect(summary.incomplete).toBe(true);
  });

  it("keeps every account represented in a mixed scan and lets kinds overlap", () => {
    const e1 = account({ pubkey: "E1", lamports: 1000 });
    const e2 = account({ pubkey: "E2", lamports: 2000, needsRevoke: true });
    const e3 = account({ pubkey: "E3", lamports: 3000, frozen: true });
    const s1 = skip({
      pubkey: "S1",
      cause: "funded",
      balance: "5",
      decimals: 6,
      lamports: 100,
    });
    const s2 = skip({
      pubkey: "S2",
      cause: "funded",
      balance: "7",
      decimals: 6,
      lamports: 200,
      delegated: true,
    });
    const s3 = skip({ pubkey: "S3", cause: "unreadable" });
    const mixed = scan({
      totalAccounts: 6,
      eligibleAccounts: [e1, e2, e3],
      recoverableLamports: 6000n,
      skippedAccounts: [s1, s2, s3],
    });
    const summary = summarizeWalletState(mixed);

    expect(summary.totals.accounts).toBe(6);
    expect(summary.totals.byKind["empty-closable"]).toBe(3);
    expect(summary.totals.byKind["active-delegation"]).toBe(2); // E2 + S2
    expect(summary.totals.byKind["frozen"]).toBe(1); // E3
    expect(summary.totals.byKind["funded-holding"]).toBe(2); // S1 + S2
    expect(summary.totals.byKind["unreadable"]).toBe(1); // S3
    // Kinds are tags, not partitions: memberships may exceed accounts.
    const membershipSum = Object.values(summary.totals.byKind).reduce(
      (sum, n) => sum + n,
      0
    );
    expect(membershipSum).toBeGreaterThanOrEqual(summary.totals.accounts);
    expect(membershipSum).toBe(9);
    // No account silently lost: 6 distinct accounts across the groups.
    const distinct = new Set(
      Object.values(summary.groups)
        .flat()
        .map((entry) => entry.pubkey)
    );
    expect(distinct.size).toBe(6);
    expect(summary.rentLamports.recoverable).toBe(6000n);
    expect(summary.rentLamports.inFundedAccounts).toBe(300n); // 100 + 200
    expect(summary.incomplete).toBe(true); // S3
  });

  it("groups reference the original scan entries, not copies", () => {
    const e1 = account({ pubkey: "E1" });
    const s1 = skip({ pubkey: "S1", cause: "funded", balance: "5", lamports: 1 });
    const summary = summarizeWalletState(
      scan({
        totalAccounts: 2,
        eligibleAccounts: [e1],
        recoverableLamports: 2039280n,
        skippedAccounts: [s1],
      })
    );
    expect(summary.groups["empty-closable"][0]).toBe(e1);
    expect(summary.groups["funded-holding"][0]).toBe(s1);
  });

  it("uses the scan's own recoverable rent as the recoverable source", () => {
    const result = scan({
      eligibleAccounts: [account({ lamports: 5 }), account({ lamports: 6 })],
      recoverableLamports: 11n,
    });
    const summary = summarizeWalletState(result);
    expect(summary.rentLamports.recoverable).toBe(result.recoverableLamports);
    expect(summary.rentLamports.recoverable).toBe(11n);
  });
});
