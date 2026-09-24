/**
 * Wallet state inspection: pure aggregation of a completed scan into an
 * evidence-first summary.
 *
 * Input is the ScanResult from getClosableAccounts; the summary counts and
 * groups those SAME entries by finding kind. Finding kinds are TAGS, not
 * partitions: one account can belong to several kinds (funded + delegated,
 * empty + frozen), so sum(byKind) may legitimately exceed totalAccounts.
 * The invariant is that no account is silently lost.
 *
 * The summary carries observable state only: counts, lamports, and
 * references to the original scan entries. There is deliberately no
 * severity, score, risk, or recommendation field. The inspection layer
 * describes what the chain says; it never judges.
 *
 * Read-only boundary: this module imports types from tokenAccounts.ts and
 * nothing else. No React, no RPC, no wallet adapter, and no action-bearing
 * module (closeAccounts/fees/transactions) may be imported here.
 */

import type {
  ClosableAccount,
  ScanResult,
  SkippedAccount,
} from "./tokenAccounts";

export const FINDING_KINDS = [
  "empty-closable",
  "funded-holding",
  "active-delegation",
  "foreign-close-authority",
  "wrapped-sol",
  "frozen",
  "uninitialized",
  "unreadable",
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

export type WalletInspectionSummary = {
  /** What the scan actually covered, so the UI can state its scope. */
  checked: {
    programs: readonly ["spl", "token-2022"];
    /** The scan reads at the network's default (finalized) commitment; the
     *  summary states that scope rather than implying a fresher view. */
    commitment: "finalized";
  };
  totals: {
    /** Total token accounts the scan observed, both programs combined. */
    accounts: number;
    /** Per-kind counts. Kinds overlap; these are memberships, not buckets. */
    byKind: Record<FindingKind, number>;
  };
  rentLamports: {
    /** Rent recoverable by closing the empty-closable accounts. This is the
     *  scan's own figure, reused unchanged. */
    recoverable: bigint;
    /** Rent sitting in accounts that hold tokens. Factual visibility only:
     *  the inspection layer does not claim this rent is recoverable. */
    inFundedAccounts: bigint;
  };
  /** References into the original scan arrays, so the summary and the
   *  detail lists can never drift apart. */
  groups: Record<FindingKind, Array<ClosableAccount | SkippedAccount>>;
  /** True when at least one observed account could not be read. */
  incomplete: boolean;
};

const CHECKED_PROGRAMS = ["spl", "token-2022"] as const;

function newGroups(): Record<
  FindingKind,
  Array<ClosableAccount | SkippedAccount>
> {
  return {
    "empty-closable": [],
    "funded-holding": [],
    "active-delegation": [],
    "foreign-close-authority": [],
    "wrapped-sol": [],
    frozen: [],
    uninitialized: [],
    unreadable: [],
  };
}

function newCounts(): Record<FindingKind, number> {
  return {
    "empty-closable": 0,
    "funded-holding": 0,
    "active-delegation": 0,
    "foreign-close-authority": 0,
    "wrapped-sol": 0,
    frozen: 0,
    uninitialized: 0,
    unreadable: 0,
  };
}

export function summarizeWalletState(
  scan: ScanResult
): WalletInspectionSummary {
  const groups = newGroups();
  const byKind = newCounts();
  let incomplete = false;
  let inFundedAccounts = 0n;

  const push = (kind: FindingKind, entry: ClosableAccount | SkippedAccount) => {
    groups[kind].push(entry);
    byKind[kind] += 1;
  };

  for (const account of scan.eligibleAccounts) {
    push("empty-closable", account);
    if (account.needsRevoke) push("active-delegation", account);
    if (account.frozen) push("frozen", account);
  }

  for (const skipped of scan.skippedAccounts) {
    switch (skipped.cause) {
      case "unreadable":
        push("unreadable", skipped);
        incomplete = true;
        break;
      case "funded": {
        push("funded-holding", skipped);
        if (skipped.frozen) push("frozen", skipped);
        if (skipped.delegated) push("active-delegation", skipped);
        inFundedAccounts += BigInt(skipped.lamports ?? 0);
        break;
      }
      case "frozen-with-delegate":
        push("frozen", skipped);
        push("active-delegation", skipped);
        break;
      case "close-authority":
        push("foreign-close-authority", skipped);
        break;
      case "wrapped-sol":
        push("wrapped-sol", skipped);
        break;
      case "uninitialized":
        push("uninitialized", skipped);
        break;
    }
  }

  return {
    checked: { programs: CHECKED_PROGRAMS, commitment: "finalized" },
    totals: { accounts: scan.totalAccounts, byKind },
    rentLamports: {
      recoverable: scan.recoverableLamports,
      inFundedAccounts,
    },
    groups,
    incomplete,
  };
}
