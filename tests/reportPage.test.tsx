// @vitest-environment jsdom

/**
 * Tests for the wallet health report page (/report).
 *
 * The report is the read-only funnel: it reuses the homepage's scan and
 * the inspection summary, adds no actions, and never asks for a
 * signature. These tests pin the read-only promise, every scan state,
 * the writing rules on the static copy, and the homepage footer link
 * that surfaces the page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Keypair, type Connection } from "@solana/web3.js";
import type { ReactNode } from "react";
import type { ScanResult } from "../src/lib/solana/tokenAccounts";

const mocks = vi.hoisted(() => ({
  wallet: {
    publicKey: null as import("@solana/web3.js").PublicKey | null,
    wallet: null,
    wallets: [] as unknown[],
    connect: vi.fn(),
    disconnect: vi.fn(),
    connecting: false,
    connected: false,
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

// next/link needs the Next.js router context that plain jsdom does not
// provide. Render a faithful anchor so hrefs stay assertable.
vi.mock("next/link", () => ({
  default: (props: { href: string; children?: ReactNode; className?: string }) => (
    <a href={props.href} className={props.className}>
      {props.children}
    </a>
  ),
}));

import ReportPage from "../src/app/report/page";
import Home from "../src/app/page";

const WALLET_KEYPAIR = Keypair.generate();

const SCAN_RESULT: ScanResult = {
  totalAccounts: 4,
  eligibleAccounts: [
    {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      lamports: 2039280,
      program: "spl",
    },
  ],
  recoverableLamports: 2039280n,
  skippedAccounts: [
    {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      reason: "holds a token balance",
      program: "spl",
      cause: "funded",
      balance: "5",
      decimals: 9,
      lamports: 2074254,
      nativeStatus: "non-native",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wallet.publicKey = null;
  mocks.wallet.connected = false;
  mocks.scan.loading = false;
  mocks.scan.result = null;
  mocks.scan.error = null;
});

afterEach(cleanup);

describe("report page read-only promise", () => {
  it("states the read-only promise and shows the connect control while disconnected", () => {
    render(<ReportPage />);

    expect(
      screen.getByText(/never asks you to sign anything/i)
    ).toBeTruthy();
    expect(screen.getByText(/nothing here moves funds/i)).toBeTruthy();
    expect(
      screen.getByText(/Every action lives on the home page/i)
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /select wallet/i })
    ).toBeTruthy();
  });

  it("describes what the page reads and what it does not", () => {
    render(<ReportPage />);

    expect(screen.getByText(/What this page reads/i)).toBeTruthy();
    expect(screen.getByText(/SOL balance, stake accounts/i)).toBeTruthy();
  });
});

describe("report page scan states", () => {
  it("shows the loading state while the scan runs", () => {
    mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
    mocks.wallet.connected = true;
    mocks.scan.loading = true;
    render(<ReportPage />);

    expect(screen.getByText(/Reading your wallet/i)).toBeTruthy();
  });

  it("shows the scan failure with a working scan-again control", () => {
    mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
    mocks.wallet.connected = true;
    mocks.scan.error = "Too many requests from your IP";
    render(<ReportPage />);

    expect(screen.getByText("Scan failed")).toBeTruthy();
    const retry = screen.getByRole("button", { name: /scan again/i });
    retry.click();
    expect(mocks.scan.rescan).toHaveBeenCalledTimes(1);
  });

  it("renders the scan summary with the inspection block when connected", () => {
    mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
    mocks.wallet.connected = true;
    mocks.scan.result = SCAN_RESULT;
    render(<ReportPage />);

    expect(screen.getByText(/4 token accounts found/i)).toBeTruthy();
    expect(screen.getByText(/1 eligible for closing/i)).toBeTruthy();
    expect(screen.getByText(/0.002039 SOL recoverable/i)).toBeTruthy();
    // The inspection summary is the same evidence block the homepage renders.
    expect(screen.getByText(/Inspected 4 token accounts/i)).toBeTruthy();
    expect(screen.getByText(/1 empty account/i)).toBeTruthy();
    expect(screen.getByText(/1 account holds tokens/i)).toBeTruthy();
  });

  it("never renders an approval or signing control in any state", () => {
    mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
    mocks.wallet.connected = true;
    mocks.scan.result = SCAN_RESULT;
    const { container } = render(<ReportPage />);

    const controls = [
      ...Array.from(container.querySelectorAll("button")),
      ...Array.from(container.querySelectorAll("a")),
    ];
    for (const control of controls) {
      expect(
        /approve|sign|repair wallet|revoke|unwrap/i.test(
          control.textContent ?? ""
        )
      ).toBe(false);
    }
    // The only outbound links are the header Back link and the pointer
    // to the home page where the actions live.
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href")
    );
    expect(hrefs).toContain("/");
    expect(hrefs).not.toContain("/understand");
    expect(screen.getByRole("link", { name: /open the repair tool/i })).toBeTruthy();
  });
});

describe("report page writing rules", () => {
  it("keeps the owner's writing rules on the static copy", () => {
    const { container } = render(<ReportPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[\u2014\u2013]/);
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(text).not.toMatch(/!/);
  });

  it("keeps the writing rules on the connected and result states too", () => {
    mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
    mocks.wallet.connected = true;
    mocks.scan.result = SCAN_RESULT;
    const { container } = render(<ReportPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[\u2014\u2013]/);
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(text).not.toMatch(/!/);
  });
});

describe("homepage surfaces the report", () => {
  it("links the health report from the footer with the right target", () => {
    render(<Home />);
    const link = screen.getByRole("link", { name: /health report/i });
    expect(link.getAttribute("href")).toBe("/report");
  });
});
