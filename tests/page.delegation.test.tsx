// @vitest-environment jsdom

/**
 * Page wiring tests for the G.2 delegation section (spec §10.4.10):
 * the section is mounted inside the scan-results block, and the repair
 * button is gated on the revoke action's in-flight signal in BOTH
 * directions of the §8.12 affordance.
 *
 * DelegationSection itself is stubbed: its copy and behavior are
 * pinned in tests/delegationSection.test.tsx; here only the page's
 * wiring is under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  Keypair,
  PublicKey,
  type Connection,
} from "@solana/web3.js";

import Home from "../src/app/page";
import type {
  ClosableAccount,
  ScanResult,
} from "../src/lib/solana/tokenAccounts";

const stub = vi.hoisted(() => ({ inFlight: true }));

const mocks = vi.hoisted(() => ({
  wallet: {
    publicKey: null as PublicKey | null,
    wallet: null,
    wallets: [] as unknown[],
    connect: vi.fn(),
    disconnect: vi.fn(),
    connecting: false,
    connected: true,
    select: vi.fn(),
  },
  scan: {
    loading: false,
    result: null as ScanResult | null,
    error: null as string | null,
    rescan: vi.fn(),
  },
  conn: {
    getAccountInfo: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
  useConnection: () => ({ connection: mocks.conn as unknown as Connection }),
}));

vi.mock("@/hooks/useWalletScan", () => ({
  useWalletScan: () => mocks.scan,
}));

vi.mock("next/link", () => ({
  default: (props: { children?: unknown }) => props.children,
}));

vi.mock("@/components/DelegationSection", async () => {
  const { useEffect } = await import("react");
  return {
    DelegationSection: ({
      onActionInFlightChange,
    }: {
      onActionInFlightChange?: (inFlight: boolean) => void;
    }) => {
      useEffect(() => {
        onActionInFlightChange?.(stub.inFlight);
      }, [onActionInFlightChange]);
      return <div data-testid="delegation-section-stub" />;
    },
  };
});

const WALLET_KEYPAIR = Keypair.generate();

const ELIGIBLE: ClosableAccount[] = [
  {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: 2039280,
    program: "spl",
  },
];

const SCAN_RESULT: ScanResult = {
  totalAccounts: 1,
  eligibleAccounts: ELIGIBLE,
  recoverableLamports: 2039280n,
  skippedAccounts: [],
};

function renderHomeWithScanResult() {
  const utils = render(<Home />);
  act(() => {
    mocks.scan.result = SCAN_RESULT;
    utils.rerender(<Home />);
  });
  return utils;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
  mocks.wallet.connected = true;
  mocks.scan.loading = false;
  mocks.scan.result = null;
  mocks.scan.error = null;
  mocks.conn.getAccountInfo.mockResolvedValue(null);
  stub.inFlight = true;
});

afterEach(cleanup);

describe("the delegation section mount and the cross-action affordance", () => {
  it("mounts the delegation section inside the scan-results block", () => {
    renderHomeWithScanResult();
    expect(
      screen.getByTestId("delegation-section-stub")
    ).toBeTruthy();
  });

  it("disables the repair button while a revoke is in flight", () => {
    renderHomeWithScanResult();
    const repair = screen.getByRole("button", {
      name: "Repair Wallet",
    }) as HTMLButtonElement;
    expect(repair.disabled).toBe(true);
    expect(
      screen.getByText("Another wallet action is underway. Wait for it to finish.")
    ).toBeTruthy();
  });

  it("re-enables the repair button once no revoke is in flight", () => {
    stub.inFlight = false;
    renderHomeWithScanResult();
    const repair = screen.getByRole("button", {
      name: "Repair Wallet",
    }) as HTMLButtonElement;
    expect(repair.disabled).toBe(false);
    expect(
      screen.queryByText("Another wallet action is underway. Wait for it to finish.")
    ).toBeNull();
  });
});
