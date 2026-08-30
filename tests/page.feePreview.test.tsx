// @vitest-environment jsdom

/**
 * Fee-preview parity tests for the repair confirmation screen (page.tsx).
 *
 * The user-facing bug this guards: the confirmation screen built its fee
 * preview unconditionally, so when the fee account did not exist on-chain
 * the preview (and the copy) still promised a fee transfer that the real
 * repair would never build. The contract under test is that the preview,
 * the confirmation copy, and the actual transaction all agree on the SAME
 * feeReady decision.
 *
 * Case 1 (fee account unavailable): no fee transfer in the preview, no
 * fee language anywhere in the copy.
 * Case 2 (fee account available): the fee transfer IS in the preview with
 * the exact recipient and amount, and the copy keeps the fee language.
 *
 * Both cases use the same two-account scan result, so the expected fee is
 * feeAmountLamports([a1, a2]) = floor(2 * 2,039,280 / 100) = 40,785.
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
import { feeAmountLamports, getFeeRecipient } from "../src/lib/solana/fees";
import {
  TOKEN_PROGRAM_ID,
  type ClosableAccount,
  type ScanResult,
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

// Two eligible accounts: one classic SPL, one Token-2022, both at the real
// rent-exempt lamport value for a token account.
const ELIGIBLE: ClosableAccount[] = [
  {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: 2039280,
    program: "spl",
  },
  {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: 2039280,
    program: "token-2022",
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
 * all eligible accounts when a new scan result arrives, so the Repair
 * Wallet button is enabled only after this second render.
 */
function renderHomeWithScanResult() {
  const utils = render(<Home />);
  act(() => {
    mocks.scan.result = SCAN_RESULT;
    utils.rerender(<Home />);
  });
  return utils;
}

describe("repair confirmation fee preview parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
    mocks.wallet.connected = true;
    mocks.scan.loading = false;
    // No result yet: renderHomeWithScanResult() delivers it on a later
    // render, the same way the real async scan does.
    mocks.scan.result = null;
    mocks.scan.error = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("shows no fee transfer and no fee copy when the fee account is unavailable", async () => {
    // The fee account does not exist on-chain: the real repair would skip
    // the fee, so the confirmation screen must not promise one.
    mocks.conn.getAccountInfo.mockResolvedValue(null);

    renderHomeWithScanResult();
    openConfirmation();

    // The copy that only appears when the fee will NOT be charged.
    await screen.findByText(/Service fee: none on this repair/);
    expect(screen.queryByText(/1% of recovered/)).toBeNull();
    expect(
      screen.getByText(/No SOL leaves your wallet on this repair/)
    ).toBeTruthy();
    expect(screen.getByText(/No fee transfer/)).toBeTruthy();

    // The raw preview must contain only closeAccount instructions.
    const preview = parsePreview();
    expect(preview.length).toBe(2);
    expect(preview.every((e) => e.instruction === "closeAccount")).toBe(true);
  });

  it("shows the fee transfer with the exact recipient and amount when the fee account exists", async () => {
    // The fee account exists: preview and copy must both show the fee,
    // with the same recipient and amount the repair would actually charge.
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
    expect(
      screen.getByText(
        /The only SOL that leaves your wallet is the 1% service fee/
      )
    ).toBeTruthy();

    const preview = parsePreview();
    const closes = preview.filter((e) => e.instruction === "closeAccount");
    const transfers = preview.filter((e) => e.instruction === "transfer");
    expect(closes.length).toBe(2);
    expect(transfers.length).toBe(1);
    expect(transfers[0].to).toBe(getFeeRecipient().toBase58());
    expect(transfers[0].lamports).toBe(feeAmountLamports(ELIGIBLE).toString());
    expect(transfers[0].note).toBe("1% success fee");
  });
});
