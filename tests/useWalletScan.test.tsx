// @vitest-environment jsdom

/**
 * Wallet-switch invariant tests for useWalletScan.
 *
 * Every page-level test mocks this hook away, so the hook's own
 * guarantee has no other guard: each scan result is tagged with the
 * wallet that produced it, and the public state is derived by
 * comparing that tag to the currently connected wallet. A scan that
 * was still in flight when the user switched wallets must never
 * surface as the new wallet's result, and a rescan (the post-repair
 * path) must drop the stale result immediately instead of displaying
 * it while the fresh scan runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { PublicKey, type Connection } from "@solana/web3.js";

import { useWalletScan } from "@/hooks/useWalletScan";
import type { ScanResult } from "@/lib/solana/tokenAccounts";

const mocks = vi.hoisted(() => ({
  wallet: {
    publicKey: null as PublicKey | null,
  },
  conn: {},
  getClosableAccounts: vi.fn(),
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
  useConnection: () => ({ connection: mocks.conn as unknown as Connection }),
}));

vi.mock("@/lib/solana/tokenAccounts", () => ({
  getClosableAccounts: mocks.getClosableAccounts,
}));

/** Deterministic distinct wallets: one seed byte is enough to differ. */
function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

function makeScan(eligible: number): ScanResult {
  if (eligible === 0) {
    return {
      totalAccounts: 0,
      eligibleAccounts: [],
      recoverableLamports: 0n,
      skippedAccounts: [],
    };
  }
  return {
    totalAccounts: 1,
    eligibleAccounts: [
      {
        pubkey: pk(11).toBase58(),
        mint: pk(12).toBase58(),
        lamports: 2039280,
        program: "spl",
      },
    ],
    recoverableLamports: 2039280n,
    skippedAccounts: [],
  };
}

beforeEach(() => {
  mocks.getClosableAccounts.mockReset();
  mocks.wallet.publicKey = null;
});

afterEach(cleanup);

describe("useWalletScan never leaks a scan across wallets", () => {
  it("never surfaces wallet A's scan after the wallet switches to B", async () => {
    const keyA = pk(1);
    const keyB = pk(2);
    const scanA = makeScan(1);
    const scanB = makeScan(0);

    let resolveA!: (result: ScanResult) => void;
    const pendingA = new Promise<ScanResult>((res) => {
      resolveA = res;
    });

    mocks.getClosableAccounts
      .mockReturnValueOnce(pendingA)
      .mockReturnValueOnce(Promise.resolve(scanB));

    mocks.wallet.publicKey = keyA;
    const { result, rerender } = renderHook(() => useWalletScan());

    // Wallet A's scan starts and is still in flight.
    await waitFor(() =>
      expect(mocks.getClosableAccounts).toHaveBeenCalledTimes(1)
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.result).toBeNull();

    // The wallet switches before A's scan resolves; B's own scan lands.
    mocks.wallet.publicKey = keyB;
    rerender();
    await waitFor(() => expect(result.current.result).toEqual(scanB));
    expect(result.current.loading).toBe(false);

    // Only now does A's scan resolve. It must never enter the public
    // state as B's result, and it must not knock B's landed state back
    // into a loading display.
    await act(async () => {
      resolveA(scanA);
    });
    expect(result.current.result).toEqual(scanB);
    expect(result.current.loading).toBe(false);
  });

  it("drops the stale result the moment a rescan is requested", async () => {
    mocks.wallet.publicKey = pk(3);
    const firstScan = makeScan(1);
    const afterRepair = makeScan(0);

    mocks.getClosableAccounts
      .mockReturnValueOnce(Promise.resolve(firstScan))
      .mockReturnValueOnce(Promise.resolve(afterRepair));

    const { result } = renderHook(() => useWalletScan());
    await waitFor(() => expect(result.current.result).toEqual(firstScan));

    act(() => {
      result.current.rescan();
    });

    // The stale result is dropped immediately, not displayed during the
    // fresh scan.
    expect(result.current.loading).toBe(true);
    expect(result.current.result).toBeNull();

    await waitFor(() => expect(result.current.result).toEqual(afterRepair));
  });
});
