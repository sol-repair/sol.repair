// @vitest-environment jsdom

/**
 * Page wiring tests for the dust burn-and-close section: the section
 * is mounted inside the scan-results block with its props (including
 * the page-owned feeReady decision), the repair button is gated on the
 * burn action's in-flight signal in BOTH directions, and the two
 * earlier sections receive the burn signal for their affordances.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";

import Home from "../src/app/page";
import type { ScanResult } from "../src/lib/solana/tokenAccounts";

const stub = vi.hoisted(() => ({
  burnInFlight: false,
  burnProps: null as Record<string, unknown> | null,
}));

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
        onActionInFlightChange?.(false);
      }, [onActionInFlightChange]);
      return <div data-testid="delegation-section-stub" />;
    },
  };
});

vi.mock("@/components/NativeAccountsSection", async () => {
  const { useEffect } = await import("react");
  return {
    NativeAccountsSection: ({
      onActionInFlightChange,
    }: {
      onActionInFlightChange?: (inFlight: boolean) => void;
    }) => {
      useEffect(() => {
        onActionInFlightChange?.(false);
      }, [onActionInFlightChange]);
      return <div data-testid="native-accounts-section-stub" />;
    },
  };
});

vi.mock("@/components/BurnDustSection", async () => {
  const { useEffect } = await import("react");
  return {
    BurnDustSection: (props: {
      scan?: unknown;
      rescan?: unknown;
      repairInFlight?: boolean;
      revokeInFlight?: boolean;
      unwrapInFlight?: boolean;
      feeReady?: boolean;
      onActionInFlightChange?: (inFlight: boolean) => void;
    }) => {
      useEffect(() => {
        stub.burnProps = { ...props };
        props.onActionInFlightChange?.(stub.burnInFlight);
      }, [props]);
      return <div data-testid="burn-dust-section-stub" />;
    },
  };
});

const WALLET_KEYPAIR = Keypair.generate();

const SCAN_RESULT: ScanResult = {
  totalAccounts: 2,
  eligibleAccounts: [
    {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      lamports: 2039280,
      program: "spl",
    },
  ],
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
  stub.burnInFlight = false;
  stub.burnProps = null;
  mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
  mocks.wallet.connected = true;
  mocks.scan.loading = false;
  mocks.scan.result = null;
  mocks.scan.error = null;
  mocks.conn.getAccountInfo.mockResolvedValue(null);
});

afterEach(cleanup);

describe("burn-dust section page wiring", () => {
  it("mounts the section with the page-owned feeReady decision and both sibling signals", () => {
    renderHomeWithScanResult();
    expect(
      screen.getByTestId("burn-dust-section-stub")
    ).toBeTruthy();
    expect(stub.burnProps).toBeTruthy();
    expect(stub.burnProps?.feeReady).toBe(false);
    expect(stub.burnProps?.revokeInFlight).toBe(false);
    expect(stub.burnProps?.unwrapInFlight).toBe(false);
    expect(stub.burnProps?.repairInFlight).toBe(false);
  });

  it("renders the section after the repair controls (the F6 order rule)", () => {
    renderHomeWithScanResult();
    const repair = screen.getByRole("button", { name: "Repair Wallet" });
    const burn = screen.getByTestId("burn-dust-section-stub");
    expect(
      Boolean(
        repair.compareDocumentPosition(burn) & Node.DOCUMENT_POSITION_FOLLOWING
      )
    ).toBe(true);
  });

  it("disables the repair button while the burn action is in flight", () => {
    stub.burnInFlight = true;
    renderHomeWithScanResult();
    const repair = screen.getByRole("button", {
      name: "Repair Wallet",
    }) as HTMLButtonElement;
    expect(repair.disabled).toBe(true);
    expect(
      screen.getByText("Another wallet action is underway. Wait for it to finish.")
    ).toBeTruthy();
  });

  it("re-enables the repair button when no action is in flight", () => {
    renderHomeWithScanResult();
    const repair = screen.getByRole("button", {
      name: "Repair Wallet",
    }) as HTMLButtonElement;
    expect(repair.disabled).toBe(false);
  });
});
