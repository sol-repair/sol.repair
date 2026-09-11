// @vitest-environment jsdom

/**
 * Scan-error copy tests (page.tsx).
 *
 * A rate-limited RPC read must not dump raw JSON on the user: the box
 * shows a plain-words sentence and keeps the raw reply below it in small
 * print so nothing is hidden. Any other error keeps today's raw
 * rendering unchanged.
 *
 * The rate-limit wordings pinned here are the two live-observed shapes
 * (Sep 8: the deployed dev site's "{"code":429,...}" body and the
 * public endpoint's "Too many requests from your IP") plus web3.js's
 * own "responded with 429" give-up wording.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  Keypair,
  PublicKey,
  type Connection,
} from "@solana/web3.js";

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
    result: null,
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

const FRIENDLY =
  /The network is limiting how fast your wallet can be read\. Wait a minute and scan again\./;

beforeEach(() => {
  mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
  mocks.scan.loading = false;
  mocks.scan.result = null;
  mocks.scan.error = null;
});

afterEach(cleanup);

describe("scan error box", () => {
  it("shows plain words and keeps the raw reply when the RPC rate limits the scan", () => {
    mocks.scan.error =
      '{"code":429,"message":"Connection rate limits exceeded"}';
    render(<Home />);

    expect(screen.getByText("Scan failed")).toBeTruthy();
    expect(screen.getByText(FRIENDLY)).toBeTruthy();
    // Nothing hidden: the raw reply stays visible in the small print.
    expect(
      screen.getByText(/Connection rate limits exceeded/)
    ).toBeTruthy();
  });

  it("recognizes the Too many requests wording the public endpoint uses", () => {
    mocks.scan.error = "Too many requests from your IP";
    render(<Home />);

    expect(screen.getByText(FRIENDLY)).toBeTruthy();
  });

  it("recognizes web3.js's responded with 429 give-up wording", () => {
    mocks.scan.error = "Server responded with 429. Retrying after 500ms delay";
    render(<Home />);

    expect(screen.getByText(FRIENDLY)).toBeTruthy();
  });

  it("does not treat a bare 429 inside error text as a rate limit", () => {
    // Base58 signatures can contain the digit run 429, so the matcher is
    // anchored to whole phrases. A signature inside an unrelated failure
    // must keep today's raw rendering, not the friendly copy.
    mocks.scan.error =
      "error looking up account 5Kd4pTb429xVfJ8mWfPqZcRk2YuLgN7: account not found";
    render(<Home />);

    expect(screen.getByText("Scan failed")).toBeTruthy();
    expect(screen.queryByText(FRIENDLY)).toBeNull();
    expect(
      screen.getByText(
        /error looking up account 5Kd4pTb429xVfJ8mWfPqZcRk2YuLgN7/
      )
    ).toBeTruthy();
  });

  it("keeps today's raw rendering for any other error", () => {
    mocks.scan.error = "Connection refused";
    render(<Home />);

    expect(screen.queryByText(FRIENDLY)).toBeNull();
    expect(screen.getByText(/Connection refused/)).toBeTruthy();
  });
});
