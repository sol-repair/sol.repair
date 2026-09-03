// @vitest-environment jsdom

/**
 * Render tests for the /fees page's conformance marker: a row whose
 * transferred amount is not exactly 1% of the rent its closes freed
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

function mockHook(rows: FeeLedgerRow[]) {
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
      screen.getByText(/not exactly 1% of the rent/i)
    ).toBeTruthy();
  });
});
