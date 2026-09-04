// @vitest-environment jsdom

/**
 * Repair-ceiling tests for the review and done screens (page.tsx).
 *
 * One repair run is capped at MAX_ACCOUNTS_PER_RUN (100) accounts - five
 * sequential wallet approvals of 20 closes each. The review screen must
 * preview the capped run (transaction count, network fee, service fee,
 * "Accounts being closed") and say plainly that the rest are closed by
 * running the repair again. Under the ceiling nothing changes, and the
 * done screen of a capped run must repeat the "run again" instruction
 * with the exact remaining count.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  Keypair,
  PublicKey,
  type Connection,
  type Transaction,
} from "@solana/web3.js";

import Home from "../src/app/page";
import { MAX_ACCOUNTS_PER_RUN } from "../src/hooks/useRepairWallet";
import { feeAmountLamports } from "../src/lib/solana/fees";
import {
  TOKEN_PROGRAM_ID,
  lamportsToSol,
  type ClosableAccount,
  type ScanResult,
} from "../src/lib/solana/tokenAccounts";

const mocks = vi.hoisted(() => ({
  wallet: {
    publicKey: null as PublicKey | null,
    signTransaction: null as
      | null
      | ((tx: Transaction) => Promise<Transaction>),
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
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
  useConnection: () => ({ connection: mocks.conn as unknown as Connection }),
}));

vi.mock("@/hooks/useWalletScan", () => ({
  useWalletScan: () => mocks.scan,
}));

// next/link needs the Next.js router context that plain jsdom does not
// provide. The footer links are not under test; render their children.
vi.mock("next/link", () => ({
  default: (props: { children?: unknown }) => props.children,
}));

const WALLET_KEYPAIR = Keypair.generate();

// 250 eligible accounts, all at the real rent-exempt lamport value for a
// token account. The capped run covers the first 100 in five batches of
// 20; the other 150 wait for a second run.
const ACCOUNTS: ClosableAccount[] = Array.from({ length: 250 }, (_, i) => ({
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  lamports: 2039280,
  program: i % 2 === 0 ? "spl" : "token-2022",
}));

const SCAN_RESULT: ScanResult = {
  totalAccounts: 250,
  eligibleAccounts: ACCOUNTS,
  recoverableLamports: 250n * 2039280n,
  skippedAccounts: [],
};

// Five batches of 20, fee per batch = floor(20 x 2039280 / 100).
const EXPECTED_SERVICE_FEE =
  BigInt(MAX_ACCOUNTS_PER_RUN / 20) * feeAmountLamports(ACCOUNTS.slice(0, 20));

/**
 * Render the page the way the real scan lands: no result on the first
 * render, then the result arrives on a later render. The page auto-selects
 * all eligible accounts when a new scan result arrives.
 */
function renderHomeWithScanResult() {
  const utils = render(<Home />);
  act(() => {
    mocks.scan.result = SCAN_RESULT;
    utils.rerender(<Home />);
  });
  return utils;
}

function openConfirmation() {
  fireEvent.click(screen.getByRole("button", { name: "Repair Wallet" }));
}

describe("repair ceiling on the review and done screens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
    mocks.wallet.connected = true;
    mocks.wallet.signTransaction = null;
    mocks.scan.loading = false;
    mocks.scan.result = null;
    mocks.scan.error = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("previews only the first 100 accounts and says the rest need a second run", async () => {
    mocks.conn.getAccountInfo.mockResolvedValue({
      lamports: 1,
      owner: TOKEN_PROGRAM_ID,
      executable: false,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    });

    renderHomeWithScanResult();
    openConfirmation();

    await screen.findByText(/Service fee \(1% of recovered\)/);

    // The capped-run copy: five approvals closing the first 100 of 250,
    // with the "run again" instruction right up front.
    expect(
      screen.getByText(/closing the first 100 of your 250 selected accounts/)
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Run the repair again after it finishes to close the remaining 150 accounts\./
      )
    ).toBeTruthy();
    expect(screen.getByText("Accounts being closed: 100")).toBeTruthy();

    // Transaction count, network fee, and service fee are computed over
    // the capped run (5 batches), not the full 250-account selection
    // (which would be 13 batches).
    expect(screen.getByText(/\(5 × 0\.000005\)/)).toBeTruthy();
    const feeLine = screen.getByText(
      (content) =>
        content.includes(`~${lamportsToSol(EXPECTED_SERVICE_FEE)} SOL`) &&
        content.includes("1% of recovered")
    );
    expect(feeLine).toBeTruthy();
  });

  it("changes nothing under the ceiling", async () => {
    mocks.conn.getAccountInfo.mockResolvedValue(null);
    const twoAccounts = ACCOUNTS.slice(0, 2);
    const smallScan: ScanResult = {
      totalAccounts: 2,
      eligibleAccounts: twoAccounts,
      recoverableLamports: 2n * 2039280n,
      skippedAccounts: [],
    };
    const utils = render(<Home />);
    act(() => {
      mocks.scan.result = smallScan;
      utils.rerender(<Home />);
    });
    openConfirmation();

    await screen.findByText(/Service fee: none on this repair/);
    expect(screen.getByText(/closing 2 empty token accounts/)).toBeTruthy();
    expect(screen.getByText("Accounts being closed: 2")).toBeTruthy();
    expect(screen.queryByText(/first 100/)).toBeNull();
    expect(screen.queryByText(/remaining/)).toBeNull();
  });

  it("reports 100 closed on the done screen and points at the remaining 150", async () => {
    mocks.conn.getAccountInfo.mockResolvedValue({
      lamports: 1,
      owner: TOKEN_PROGRAM_ID,
      executable: false,
      data: Buffer.alloc(0),
      rentEpoch: 0,
    });
    mocks.conn.getLatestBlockhash.mockResolvedValue({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1000,
    });
    mocks.conn.sendRawTransaction.mockResolvedValue("signed-tx-id");
    mocks.conn.confirmTransaction.mockResolvedValue({ value: { err: null } });
    mocks.wallet.signTransaction = vi.fn(async (tx: Transaction) => {
      tx.sign(WALLET_KEYPAIR);
      return tx;
    });

    renderHomeWithScanResult();
    openConfirmation();

    // Drive the full capped repair (five mocked batches) to completion
    // inside act, so the done screen reflects the finished run.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve & Repair" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText(/Wallet repaired/)).toBeTruthy();
    expect(
      screen.getByText(
        `100 accounts closed. Recovered ${lamportsToSol(100n * 2039280n)} SOL.`
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Run the repair again to close the remaining 150 accounts\./
      )
    ).toBeTruthy();
  });
});
