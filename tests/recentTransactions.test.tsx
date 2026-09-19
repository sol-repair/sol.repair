// @vitest-environment jsdom

/**
 * Tests for the read-only recent-transactions walk (M4a).
 *
 * The walk lists a connected wallet's newest signatures and hands a
 * chosen one to the explainer. The suite lock this file enforces in code:
 * connecting and listing must NEVER call signTransaction or
 * sendTransaction on the wallet. Those spies live in the wallet mock and
 * every test asserts they stay untouched.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const mocks = vi.hoisted(() => {
  const signTransaction = vi.fn();
  const sendTransaction = vi.fn();
  return {
    signTransaction,
    sendTransaction,
    wallet: {} as Record<string, unknown>,
    fetchFeeSignatures: vi.fn(),
  };
});

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    ...mocks.wallet,
    signTransaction: mocks.signTransaction,
    sendTransaction: mocks.sendTransaction,
  }),
}));

vi.mock("@/lib/solana/feeLedger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/solana/feeLedger")>();
  return { ...actual, fetchFeeSignatures: mocks.fetchFeeSignatures };
});

import { WalletRecentTransactions } from "@/components/WalletRecentTransactions";

const ADDRESS = Keypair.generate().publicKey;
const ENDPOINT = "https://api.devnet.solana.com";
const onSelect = vi.fn();

function disconnectedWallet(): Record<string, unknown> {
  return {
    wallet: null,
    wallets: [],
    connect: vi.fn(),
    connected: false,
    connecting: false,
    disconnect: vi.fn(),
    publicKey: null,
  };
}

function connectedWallet(): Record<string, unknown> {
  return {
    wallet: { adapter: { name: "Phantom" } },
    wallets: [],
    connect: vi.fn(),
    connected: true,
    connecting: false,
    disconnect: vi.fn(),
    publicKey: ADDRESS,
  };
}

beforeEach(() => {
  mocks.wallet = disconnectedWallet();
  mocks.fetchFeeSignatures.mockReset();
  mocks.signTransaction.mockReset();
  mocks.sendTransaction.mockReset();
  onSelect.mockReset();
});

afterEach(cleanup);

describe("wallet recent transactions walk", () => {
  it("offers a connect control and no list while disconnected", () => {
    render(<WalletRecentTransactions endpoint={ENDPOINT} onSelect={onSelect} />);
    expect(
      screen.getByRole("button", { name: /list your recent transactions/i })
    ).toBeTruthy();
    expect(screen.queryByText(/your most recent transactions/i)).toBeNull();
    expect(mocks.fetchFeeSignatures).not.toHaveBeenCalled();
  });

  it("lists the wallet's newest signatures with dates when connected", async () => {
    mocks.wallet = connectedWallet();
    mocks.fetchFeeSignatures.mockResolvedValue([
      { signature: "SigOne1111111111111111111111111111111111111111", blockTime: 1789215763 },
      { signature: "SigTwo2222222222222222222222222222222222222222", blockTime: null },
    ]);
    render(<WalletRecentTransactions endpoint={ENDPOINT} onSelect={onSelect} />);
    expect(
      await screen.findByText(/your most recent transactions/i)
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /SigOne11/ })
      ).toBeTruthy()
    );
    expect(screen.getByRole("button", { name: /SigTwo22/ })).toBeTruthy();
    expect(screen.getByText(/2026-09-12/)).toBeTruthy();
    expect(mocks.fetchFeeSignatures).toHaveBeenCalledWith(
      ENDPOINT,
      ADDRESS.toBase58()
    );
  });

  it("hands the chosen signature to the explainer and never signs anything", async () => {
    mocks.wallet = connectedWallet();
    mocks.fetchFeeSignatures.mockResolvedValue([
      { signature: "SigThree333333333333333333333333333333333333333", blockTime: 1789215763 },
    ]);
    render(<WalletRecentTransactions endpoint={ENDPOINT} onSelect={onSelect} />);
    const row = await screen.findByRole("button", { name: /SigThree…3333/ });
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(
      "SigThree333333333333333333333333333333333333333"
    );
    expect(mocks.signTransaction).not.toHaveBeenCalled();
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
  });

  it("says honestly when the wallet has no transactions on this network", async () => {
    mocks.wallet = connectedWallet();
    mocks.fetchFeeSignatures.mockResolvedValue([]);
    render(<WalletRecentTransactions endpoint={ENDPOINT} onSelect={onSelect} />);
    expect(
      await screen.findByText(/No transactions found for this wallet/i)
    ).toBeTruthy();
  });

  it("shows a friendly error with the raw detail when the RPC fails", async () => {
    mocks.wallet = connectedWallet();
    mocks.fetchFeeSignatures.mockRejectedValue(
      new Error("429 Connection rate limits exceeded")
    );
    render(<WalletRecentTransactions endpoint={ENDPOINT} onSelect={onSelect} />);
    expect(await screen.findByText(/Could not reach the RPC/i)).toBeTruthy();
    expect(
      await screen.findByText(/429 Connection rate limits exceeded/i)
    ).toBeTruthy();
  });

  it("warns honestly when no wallet is detected in the browser", () => {
    render(<WalletRecentTransactions endpoint={ENDPOINT} onSelect={onSelect} />);
    fireEvent.click(
      screen.getByRole("button", { name: /list your recent transactions/i })
    );
    expect(
      screen.getByText(/No Solana wallet detected in this browser/i)
    ).toBeTruthy();
  });
});
