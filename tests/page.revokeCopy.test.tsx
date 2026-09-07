// @vitest-environment jsdom

/**
 * Revoke-copy tests for the scan rows and the repair confirmation screen
 * (page.tsx).
 *
 * An empty delegated account is eligible: the repair revokes the delegate
 * right before closing. The GUI must say so everywhere it matters:
 *   - the scan row is tagged "revoke + close" (clean rows are not),
 *   - the review screen counts the delegated accounts in the run,
 *   - the inspector copy names the revoke instruction,
 *   - the raw preview shows the real revoke instruction BEFORE the
 *     closeAccount it belongs to.
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

// One delegated account (the repair revokes it first) and one clean one.
const DELEGATED_PUBKEY = Keypair.generate().publicKey.toBase58();
const CLEAN_PUBKEY = Keypair.generate().publicKey.toBase58();

const ELIGIBLE: ClosableAccount[] = [
  {
    pubkey: DELEGATED_PUBKEY,
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: 2039280,
    program: "spl",
    needsRevoke: true,
  },
  {
    pubkey: CLEAN_PUBKEY,
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: 2039280,
    program: "spl",
  },
];

const SCAN_RESULT: ScanResult = {
  totalAccounts: 2,
  eligibleAccounts: ELIGIBLE,
  recoverableLamports: 4078560n,
  skippedAccounts: [],
};

function parsePreview(): Array<{
  program: string;
  instruction: string;
  accountToClose?: string;
  rentDestination?: string;
  closeAuthority?: string;
  authority?: string;
  to?: string;
  lamports?: string;
  note?: string;
}> {
  const summary = screen.getByText(/Inspect exactly what you/);
  const pre = summary.closest("details")?.querySelector("pre");
  if (!pre?.textContent) {
    throw new Error("transaction preview <pre> not found");
  }
  return JSON.parse(pre.textContent);
}

function openConfirmation() {
  fireEvent.click(screen.getByRole("button", { name: "Repair Wallet" }));
}

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

describe("revoke copy on the scan and confirmation screens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
    mocks.wallet.connected = true;
    mocks.scan.loading = false;
    mocks.scan.result = null;
    mocks.scan.error = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("tags only the delegated row and counts the run's delegated accounts", async () => {
    // Fee account unavailable: the review copy takes the no-fee path.
    mocks.conn.getAccountInfo.mockResolvedValue(null);

    renderHomeWithScanResult();

    // Exactly one scan row is tagged: the delegated one.
    expect(screen.getAllByText(/revoke \+ close/)).toHaveLength(1);

    openConfirmation();
    await screen.findByText(/Service fee: none on this repair/);

    expect(
      screen.getByText(/Delegated accounts in this run: 1/)
    ).toBeTruthy();
  });

  it("shows the revoke instruction before its own close in the raw preview", async () => {
    mocks.conn.getAccountInfo.mockResolvedValue(null);

    renderHomeWithScanResult();
    openConfirmation();
    await screen.findByText(/Service fee: none on this repair/);

    const preview = parsePreview();
    // Preview rows: one revoke, two closes, no fee transfer.
    expect(preview.length).toBe(3);
    const revokeIndex = preview.findIndex((e) => e.instruction === "revoke");
    expect(revokeIndex).toBeGreaterThanOrEqual(0);

    const revoke = preview[revokeIndex];
    expect(revoke.accountToClose).toBe(DELEGATED_PUBKEY);
    expect(revoke.authority).toBe(WALLET_KEYPAIR.publicKey.toBase58());
    expect(revoke.note).toBe("clears the active delegate");

    const delegatedCloseIndex = preview.findIndex(
      (e) =>
        e.instruction === "closeAccount" &&
        e.accountToClose === DELEGATED_PUBKEY
    );
    expect(revokeIndex).toBeLessThan(delegatedCloseIndex);
  });

  it("names the revoke instruction in the inspector copy", async () => {
    mocks.conn.getAccountInfo.mockResolvedValue(null);

    renderHomeWithScanResult();
    openConfirmation();
    await screen.findByText(/Service fee: none on this repair/);

    expect(
      screen.getByText(
        /revoke instruction for each account with an active delegate/
      )
    ).toBeTruthy();
  });
});
