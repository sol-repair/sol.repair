// @vitest-environment jsdom

/**
 * Page wiring tests for the G.3 native-accounts section (spec
 * §10.4.7): the section is mounted inside the scan-results block with
 * its props, and the repair button is gated on the unwrap action's
 * in-flight signal in BOTH directions of the §8.11 affordance.
 *
 * Both action sections are stubbed: their copy and behavior are pinned
 * in tests/nativeAccountsSection.test.tsx and
 * tests/delegationSection.test.tsx; here only the page's wiring is
 * under test.
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

const stub = vi.hoisted(() => ({
  revokeInFlight: false,
  unwrapInFlight: false,
  nativeProps: null as Record<string, unknown> | null,
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
        onActionInFlightChange?.(stub.revokeInFlight);
      }, [onActionInFlightChange]);
      return <div data-testid="delegation-section-stub" />;
    },
  };
});

vi.mock("@/components/NativeAccountsSection", async () => {
  const { useEffect } = await import("react");
  return {
    NativeAccountsSection: (props: {
      scan?: unknown;
      rescan?: unknown;
      repairInFlight?: boolean;
      revokeInFlight?: boolean;
      onActionInFlightChange?: (inFlight: boolean) => void;
    }) => {
      useEffect(() => {
        stub.nativeProps = { ...props };
        props.onActionInFlightChange?.(stub.unwrapInFlight);
      }, [props]);
      return <div data-testid="native-accounts-section-stub" />;
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
  stub.revokeInFlight = false;
  stub.unwrapInFlight = false;
  stub.nativeProps = null;
});

afterEach(cleanup);

describe("the native-accounts section mount and the three-way affordance", () => {
  it("mounts the native-accounts section inside the scan-results block", () => {
    renderHomeWithScanResult();
    expect(
      screen.getByTestId("native-accounts-section-stub")
    ).toBeTruthy();
    expect(screen.getByTestId("delegation-section-stub")).toBeTruthy();
  });

  it("passes the scan, the rescan callback, and both in-flight booleans as props", () => {
    stub.revokeInFlight = true;
    renderHomeWithScanResult();
    expect(stub.nativeProps).toBeTruthy();
    expect(stub.nativeProps!.scan).toBe(SCAN_RESULT);
    expect(stub.nativeProps!.repairInFlight).toBe(false);
    expect(stub.nativeProps!.revokeInFlight).toBe(true);
    expect(typeof stub.nativeProps!.rescan).toBe("function");
    expect(typeof stub.nativeProps!.onActionInFlightChange).toBe("function");
  });

  it("disables the repair button while an unwrap is in flight", () => {
    stub.unwrapInFlight = true;
    renderHomeWithScanResult();
    const repair = screen.getByRole("button", {
      name: "Repair Wallet",
    }) as HTMLButtonElement;
    expect(repair.disabled).toBe(true);
    expect(
      screen.getByText(
        "Another wallet action is underway. Wait for it to finish."
      )
    ).toBeTruthy();
  });

  it("re-enables the repair button once no action is in flight", () => {
    renderHomeWithScanResult();
    const repair = screen.getByRole("button", {
      name: "Repair Wallet",
    }) as HTMLButtonElement;
    expect(repair.disabled).toBe(false);
    expect(
      screen.queryByText(
        "Another wallet action is underway. Wait for it to finish."
      )
    ).toBeNull();
  });

  it("keeps the repair button disabled when BOTH other actions are in flight", () => {
    stub.revokeInFlight = true;
    stub.unwrapInFlight = true;
    renderHomeWithScanResult();
    const repair = screen.getByRole("button", {
      name: "Repair Wallet",
    }) as HTMLButtonElement;
    expect(repair.disabled).toBe(true);
  });

  it("renders the repair controls before both secondary action sections", () => {
    // Audit F6: with delegations and wrapped-SOL accounts present, the
    // primary action must not sit below the two secondary sections -
    // on a phone that put "Repair Wallet" one to two viewports below
    // the account selection it belongs to. The full repair flow
    // (button, review, in-flight, results) renders first; the
    // per-item sections follow.
    renderHomeWithScanResult();
    const repair = screen.getByRole("button", { name: "Repair Wallet" });
    const delegation = screen.getByTestId("delegation-section-stub");
    const native = screen.getByTestId("native-accounts-section-stub");
    const repairComesBefore = (later: Element) =>
      Boolean(
        repair.compareDocumentPosition(later) &
          Node.DOCUMENT_POSITION_FOLLOWING
      );
    expect(repairComesBefore(delegation)).toBe(true);
    expect(repairComesBefore(native)).toBe(true);
  });
});
