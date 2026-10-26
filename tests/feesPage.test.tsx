// @vitest-environment jsdom

/**
 * Render tests for the /fees page's conformance marker: a row whose
 * transferred amount is not exactly 1% of the SOL its closes returned
 * (onePercentMatch === false) shows the amber "not a 1% fee" tag, and
 * the intro states the rule openly. Conforming and unverifiable rows
 * stay untagged.
 *
 * The hook is the only mocked boundary; the page component under test
 * is the real one.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFeeLedger } from "@/hooks/useFeeLedger";
import type { FeeLedgerRow } from "@/lib/solana/feeLedger";
import { RECOVERED_TOTALS } from "@/lib/recoveredTotals";
import FeesPage from "@/app/fees/page";

vi.mock("@/hooks/useFeeLedger", () => ({
  useFeeLedger: vi.fn(),
}));

const FEE_WALLET = "6qhajWTtUKadkMaumpADGBkmPkASiwXRqGtqd8ypL74K";

function row(overrides: Partial<FeeLedgerRow>): FeeLedgerRow {
  return {
    signature: "sig-default-1111111111111111111111111111111111111111",
    blockTime: 1755577001,
    lamports: 20_392,
    onePercentMatch: null,
    ...overrides,
  };
}

function mockHook(rows: FeeLedgerRow[], unreadableCount = 0) {
  vi.mocked(useFeeLedger).mockReturnValue({
    cluster: "mainnet-beta",
    setCluster: vi.fn(),
    rows,
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    loadMore: vi.fn(),
    reload: vi.fn(),
    fetchedAt: 1755577001_000,
    now: 1755577001_000,
    feeWallet: FEE_WALLET,
    totalLamports: rows.reduce((sum, r) => sum + r.lamports, 0),
    unreadableCount,
  });
}

afterEach(cleanup);

describe("fees page 1% conformance marker", () => {
  it("tags exactly the non-conforming rows", () => {
    mockHook([
      row({
        signature: "conforming-1111111111111111111111111111111111111",
        onePercentMatch: true,
      }),
      row({
        signature: "nonconforming-111111111111111111111111111111111",
        lamports: 100_000,
        onePercentMatch: false,
      }),
      row({
        signature: "unverifiable-1111111111111111111111111111111111",
        onePercentMatch: null,
      }),
    ]);
    render(<FeesPage />);

    const tags = screen.getAllByText("not a 1% fee");
    expect(tags).toHaveLength(1);
    // the page renders signatures through short(): first 6 + last 4 chars
    expect(screen.getByText(/confor…1111/)).toBeTruthy();
    expect(screen.getByText(/noncon…1111/)).toBeTruthy();
  });

  it("tags nothing when every row conforms (or is unverifiable)", () => {
    mockHook([
      row({
        signature: "conforming-1111111111111111111111111111111111111",
        onePercentMatch: true,
      }),
      row({
        signature: "unverifiable-1111111111111111111111111111111111",
        onePercentMatch: null,
      }),
    ]);
    render(<FeesPage />);

    expect(screen.queryByText("not a 1% fee")).toBeNull();
  });

  it("states the 1% rule in the intro copy", () => {
    mockHook([]);
    render(<FeesPage />);

    expect(
      screen.getByText(/not exactly 1% of the SOL/i)    ).toBeTruthy();
  });
});

describe("fees page: the unwrap rule beside the repair rule (G.3 §7.7, additive)", () => {
  it("states the no-fee rule for wrapped-SOL unwrap", () => {
    mockHook([]);
    render(<FeesPage />);

    expect(
      screen.getByText(
        /no service fee\. you are recovering your own sol; the only cost is the network fee\./i
      )
    ).toBeTruthy();
  });

  it("states the 1%-of-recovered rule for repair closes beside it", () => {
    mockHook([]);
    render(<FeesPage />);

    expect(
      screen.getByText(
        /a 1% service fee on the rent the close recovers, charged only when sol is successfully recovered, appended after the closes, and visible in the ledger below\./i
      )
    ).toBeTruthy();
  });

  it("writes the shared rationale beside both rules, naming the asymmetry (F1)", () => {
    mockHook([]);
    render(<FeesPage />);

    expect(
      screen.getByText(
        /the fee exists for unlocking rent a user cannot reach themselves, never for returning the user.s own principal\./i
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        /an empty wrapped-sol account recovers rent the same way an empty ordinary account does, but the unwrap path returns it fee-free while the repair path charges 1% on the same kind of recovery\./i
      )
    ).toBeTruthy();
    expect(screen.getByText(/That asymmetry is the honest cost/i)).toBeTruthy();
  });

  it("states the dust burn-and-close rule (the owner's 2026-09-26 ruling)", () => {
    mockHook([]);
    render(<FeesPage />);

    expect(
      screen.getByText(
        /the same 1% fee on the rent the close recovers/i
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        /The burn itself destroys the token balance permanently and is charged nothing/i
      )
    ).toBeTruthy();
  });

  it("keeps the pre-existing 1% conformance copy intact", () => {
    mockHook([]);
    render(<FeesPage />);

    expect(screen.getByText(/not exactly 1% of the SOL/i)).toBeTruthy();
  });
});

describe("fees page: the incomplete-history notice (audit F2)", () => {
  const SINGULAR =
    "1 transaction in this history could not be read from the RPC. " +
    "It is left out of the list, so the list can be incomplete.";
  const PLURAL =
    "3 transactions in this history could not be read from the RPC. " +
    "They are left out of the list, so the list can be incomplete.";

  it("names the unreadable count beside the rows when the RPC returned nulls", () => {
    mockHook(
      [
        row({
          signature: "surviving-11111111111111111111111111111111111",
          lamports: 20_392,
          onePercentMatch: true,
        }),
      ],
      3
    );
    render(<FeesPage />);

    expect(screen.getByText(PLURAL)).toBeTruthy();
    expect(screen.getByText(/surviv…1111/)).toBeTruthy();
  });

  it("uses the singular sentence for one unreadable transaction, even beside the empty state", () => {
    mockHook([], 1);
    render(<FeesPage />);

    expect(screen.getByText(SINGULAR)).toBeTruthy();
    // The honest empty state still renders; the notice corrects it.
    expect(screen.getByText("No fees collected yet.")).toBeTruthy();
  });

  it("stays silent when every transaction read", () => {
    mockHook(
      [
        row({
          signature: "clean-111111111111111111111111111111111111111",
        }),
      ],
      0
    );
    render(<FeesPage />);

    expect(screen.queryByText(/could not be read from the RPC/)).toBeNull();
  });

  it("keeps the owner's writing rules on the notice copy", () => {
    for (const text of [SINGULAR, PLURAL]) {
      expect(text.includes("—") || text.includes("–")).toBe(false);
      expect(text.includes("!")).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    }
  });
});

describe("fees page recovered-to-date line", () => {
  it("renders the weekly all-time line from the generated constant", () => {
    mockHook([]);
    render(<FeesPage />);

    // Values come from the generated constant, so the Sunday bump can
    // never break this pin: the test reads the same module the page does.
    expect(
      screen.getByText(
        new RegExp(
          `As of .+: ${RECOVERED_TOTALS.lamportsFreedSol} SOL recovered through repairs and burn-closes for ${RECOVERED_TOTALS.wallets} wallets across ${RECOVERED_TOTALS.closes} accounts\. Updated weekly\.`
        )
      )
    ).toBeTruthy();
  });
});
