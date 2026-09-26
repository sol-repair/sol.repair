// @vitest-environment jsdom

/**
 * In-flight repair progress tests (page.tsx).
 *
 * The first real mainnet repair (the owner, iPhone, Phantom) exposed a
 * dead window: after approving in the wallet, the page showed only
 * static text while the network confirmed, and a static line reads as
 * frozen ("is this stuck? is this a scam?"). The in-flight box must
 * show motion, a ticking elapsed-seconds counter, and the batch
 * position. Stage names come from the repair hook's real states; no
 * fake percentages and no countdowns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
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

vi.mock("@/hooks/useRepairWallet", async () => ({
  useRepairWallet: () => mocks.repair,
  // The page also imports the cap constant for its copy, so the fake must
  // carry it too. Read the REAL export rather than a copy of its value: a
  // hand-written 100 here would drift silently if the cap ever changed.
  MAX_ACCOUNTS_PER_RUN: (
    await vi.importActual<typeof import("@/hooks/useRepairWallet")>(
      "@/hooks/useRepairWallet"
    )
  ).MAX_ACCOUNTS_PER_RUN,
}));

// next/link needs the Next.js router context that plain jsdom does not
// provide. The footer links are not under test; render their children.
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

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("in-flight repair progress panel", () => {
  it("shows motion and a ticking counter while the network confirms", async () => {
    vi.useFakeTimers();
    mocks.repair.status = "verifying";
    render(<Home />);

    const box = screen.getByRole("status");
    expect(box.textContent).toContain(
      "Sent. Waiting for the network to confirm it..."
    );
    expect(box.querySelector("svg.animate-spin")).toBeTruthy();
    expect(screen.getByText("0s")).toBeTruthy();
    // The ticking number must stay out of the live region (audit F5):
    // aria-hidden keeps screen readers from re-announcing every tick.
    expect(screen.getByText("0s").getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("3s")).toBeTruthy();
    expect(screen.queryByText("0s")).toBeNull();
  });

  it("marks the sending stage as approved and in flight", () => {
    mocks.repair.status = "sending";
    render(<Home />);

    const box = screen.getByRole("status");
    expect(box.textContent).toContain("Approved. Sending to the network...");
    expect(box.querySelector("svg.animate-spin")).toBeTruthy();
    expect(screen.getByText("0s")).toBeTruthy();
  });

  it("shows the real batch position for multi-transaction repairs", () => {
    mocks.repair.status = "sending";
    mocks.repair.progress = { current: 2, total: 5 };
    render(<Home />);

    const box = screen.getByRole("status");
    expect(box.textContent).toContain("Transaction 2 of 5");
  });

  it("keeps the wallet prompt while waiting for the signature", () => {
    mocks.repair.status = "awaiting-signature";
    render(<Home />);

    const box = screen.getByRole("status");
    expect(box.textContent).toContain(
      "Check your wallet. Phantom is asking you to approve."
    );
    expect(box.querySelector("svg.animate-spin")).toBeTruthy();
  });

  it("keeps the owner's writing rules on the in-flight copy", () => {
    const panels: string[] = [];
    for (const status of ["sending", "verifying"]) {
      mocks.repair.status = status;
      const { unmount } = render(<Home />);
      panels.push(screen.getByRole("status").textContent ?? "");
      unmount();
    }
    const text = panels.join(" ");
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});
