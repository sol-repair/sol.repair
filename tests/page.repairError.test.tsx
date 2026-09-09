// @vitest-environment jsdom

/**
 * Repair-failed box tests (page.tsx).
 *
 * When the repair fails for a reason the product has plain words for
 * (cancelled, expired, partial, wallet changed), the box shows exactly
 * that copy and no raw text. When the failure is an unrecognized
 * library or network error, the box shows one honest generic line and
 * keeps the raw error collapsed behind a "Technical details" toggle so
 * nothing is hidden and nothing developer-facing is dumped on the user.
 *
 * The raw shape pinned here is the live-observed Sep 8 mid-flight
 * send refusal, including web3.js's developer-instruction tail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    confirmTransaction: vi.fn(),
    simulateTransaction: vi.fn(),
  },
  repair: {
    status: "idle" as string,
    signature: null as string | null,
    signatures: [] as string[],
    closedCount: 0,
    totalToClose: 0,
    recoveredLamports: 0n,
    progress: null,
    error: null as string | null,
    errorDetail: null as string | null,
    repair: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
  useConnection: () => ({ connection: mocks.conn as unknown as Connection }),
}));

vi.mock("@/hooks/useWalletScan", () => ({
  useWalletScan: () => mocks.scan,
}));

vi.mock("@/hooks/useRepairWallet", () => ({
  useRepairWallet: () => mocks.repair,
  // The page also imports the cap constant for its copy; the value
  // matches the real export and is irrelevant to these tests.
  MAX_ACCOUNTS_PER_RUN: 100,
}));

// next/link needs the Next.js router context that plain jsdom does not
// provide. The footer links are not under test; render their children.
vi.mock("next/link", () => ({
  default: (props: { children?: unknown }) => props.children,
}));

const GENERIC =
  "The repair transaction did not go through. Nothing was closed. Run the repair again.";

const RAW =
  "SendTransactionError: failed to send transaction: Transaction simulation failed: Error: Non-native account can only be closed if its balance is zero. Catch the `SendTransactionError` and call `getLogs()` on it for full details.";

const SCAN_RESULT: ScanResult = {
  totalAccounts: 1,
  eligibleAccounts: [
    {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      lamports: 2039280,
      program: "spl",
    } satisfies ClosableAccount,
  ],
  skippedAccounts: [],
  recoverableLamports: 2039280n,
};

beforeEach(() => {
  mocks.wallet.publicKey = Keypair.generate().publicKey;
  mocks.scan.loading = false;
  mocks.scan.result = SCAN_RESULT;
  mocks.scan.error = null;
  mocks.repair.status = "error";
  mocks.repair.error = null;
  mocks.repair.errorDetail = null;
});

afterEach(cleanup);

describe("repair failed box", () => {
  it("shows the generic line with the raw error collapsed under Technical details", () => {
    mocks.repair.error = GENERIC;
    mocks.repair.errorDetail = RAW;

    render(<Home />);

    expect(screen.getByText("Repair failed")).toBeTruthy();
    expect(screen.getByText(GENERIC)).toBeTruthy();

    // The raw text exists only inside a details element that starts
    // collapsed: available to anyone who wants it, dumped on no one.
    const summary = screen.getByText("Technical details");
    const details = summary.closest("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toMatch(/getLogs/);
  });

  it("renders no raw-detail section for failures the copy already explains", () => {
    mocks.repair.error =
      "The transaction expired while waiting for approval. The network moved on while the wallet window was open. Nothing was sent and nothing was lost. Please try again and approve promptly.";
    mocks.repair.errorDetail = null;

    render(<Home />);

    expect(
      screen.getByText(/expired while waiting for approval/)
    ).toBeTruthy();
    expect(screen.queryByText("Technical details")).toBeNull();
  });
});
