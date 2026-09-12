// @vitest-environment jsdom

/**
 * Honest failure reporting tests (page.tsx + useRepairWallet copy).
 *
 * The generic failure copy claimed "Nothing was closed" as a fact. That
 * is provable at the moment the chain was checked, but in the
 * wallet-submission race window the check can read open while the
 * wallet's own submission is still propagating. The copy must say only
 * what was proven: nothing was closed when we checked. The error box
 * must also render the receipt signatures the hook preserves (its
 * verify-fallback copy already promises "the linked signature"), and
 * the transient chain-check state must not claim "Sent.", because in
 * that path our submission may have failed while the wallet submitted
 * independently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  Keypair,
  type Connection,
  type PublicKey,
} from "@solana/web3.js";
import type { ScanResult } from "@/lib/solana/tokenAccounts";

import Home from "../src/app/page";

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
  repair: {
    status: "idle" as string,
    signature: null as string | null,
    signatures: [] as string[],
    closedCount: 0,
    recoveredLamports: 0n,
    progress: null as { current: number; total: number } | null,
    error: null as string | null,
    errorDetail: null as string | null,
    repair: vi.fn(),
    reset: vi.fn(),
  },
  conn: {
    getAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    confirmTransaction: vi.fn(),
    simulateTransaction: vi.fn(),
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
  MAX_ACCOUNTS_PER_RUN: 100,
}));

vi.mock("next/link", () => ({
  default: (props: { children?: unknown }) => props.children,
}));

const WALLET_KEYPAIR = Keypair.generate();

const SCAN_RESULT: ScanResult = {
  totalAccounts: 1,
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

const GENERIC =
  "The repair transaction did not go through. No accounts were closed when we checked the chain. Solana transactions are atomic, so nothing half-landed. Dismiss to refresh the scan, then run the repair again if accounts are still open.";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.conn.getAccountInfo.mockResolvedValue(null);
  mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
  mocks.scan.loading = false;
  mocks.scan.result = SCAN_RESULT;
  mocks.scan.error = null;
  mocks.repair.status = "idle";
  mocks.repair.signature = null;
  mocks.repair.signatures = [];
  mocks.repair.progress = null;
  mocks.repair.error = null;
  mocks.repair.errorDetail = null;
});

afterEach(cleanup);

describe("honest repair failure reporting", () => {
  it("states only the provable fact in the generic failure copy", () => {
    mocks.repair.status = "error";
    mocks.repair.error = GENERIC;
    render(<Home />);

    expect(screen.getByText(/No accounts were closed when we checked the chain/)).toBeTruthy();
    expect(screen.queryByText(/Nothing was closed\. Run/)).toBeNull();
  });

  it("renders the receipt signature the hook preserved", () => {
    mocks.repair.status = "error";
    mocks.repair.error = GENERIC;
    mocks.repair.signatures = [
      "2V4dcrHEApzHDS9PqxWo1KeeK8a3HvVLyPsxVfq3yEktjdqH8NX77nzGZVT4QXTaVy8sWvszA8xDx8N2UrYGfrcw",
    ];
    render(<Home />);

    const link = screen.getByText("View on Solscan") as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.href).toContain("solscan.io/tx/");
    expect(link.href).toContain("2V4dcrHE");
  });

  it("shows no signature link when nothing was sent", () => {
    mocks.repair.status = "error";
    mocks.repair.error = "Transaction cancelled. Nothing was sent.";
    render(<Home />);

    expect(screen.queryByText("View on Solscan")).toBeNull();
  });

  it("checks the chain without claiming the transaction was sent", () => {
    mocks.repair.status = "checking";
    render(<Home />);

    const box = screen.getByRole("status");
    expect(box.textContent).toContain(
      "Checking the chain for what actually landed..."
    );
    expect(box.textContent).not.toContain("Sent.");
    expect(box.querySelector("svg.animate-spin")).toBeTruthy();
  });

  it("keeps the owner's writing rules on the failure copy", () => {
    mocks.repair.status = "error";
    mocks.repair.error = GENERIC;
    render(<Home />);

    const text = screen.getByText(/No accounts were closed/).textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});
