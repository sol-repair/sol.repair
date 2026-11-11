// @vitest-environment jsdom

/**
 * The /understand page's network honesty (FA5). A deployment configured
 * for a network this page does not serve (testnet, localhost) must say
 * so instead of silently querying the devnet endpoint. The connection
 * module is mocked to the unsupported network here; the main suite runs
 * against the real (devnet-default) module.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
  ConnectionProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
  WalletProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
}));

// The unsupported-network deployment: testnet.
vi.mock("@/lib/solana/connection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/solana/connection")>();
  return {
    ...actual,
    IS_MAINNET: false,
    SOLANA_NETWORK: "testnet" as const,
  };
});

vi.mock("@/lib/solana/feeLedger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/solana/feeLedger")>();
  return {
    ...actual,
    fetchRawTransaction: vi.fn(),
    fetchFeeSignatures: vi.fn(),
  };
});

import { fetchRawTransaction } from "@/lib/solana/feeLedger";
import UnderstandPage, {
  understandSupportsNetwork,
} from "@/app/understand/understand-client";

const mockedFetch = vi.mocked(fetchRawTransaction);

afterEach(cleanup);

describe("the understand page's network honesty (FA5)", () => {
  it("renders an explicit unsupported-network state on testnet and fetches nothing", () => {
    render(<UnderstandPage />);
    expect(
      screen.getByText(/This network is not supported here/)
    ).toBeTruthy();
    expect(
      screen.getByText(/configured for the testnet network/)
    ).toBeTruthy();
    expect(screen.getByText(/Nothing is fetched/)).toBeTruthy();
    // The explainer form and the wallet's recent-transactions list are
    // not rendered: either one would query the devnet endpoint.
    expect(screen.queryByRole("button", { name: /explain it/i })).toBeNull();
    expect(mockedFetch).not.toHaveBeenCalled();
    void fetchRawTransaction;
  });

  it("classifies the four configured networks honestly", () => {
    expect(understandSupportsNetwork("mainnet-beta")).toBe(true);
    expect(understandSupportsNetwork("devnet")).toBe(true);
    expect(understandSupportsNetwork("testnet")).toBe(false);
    expect(understandSupportsNetwork("localhost")).toBe(false);
  });
});
