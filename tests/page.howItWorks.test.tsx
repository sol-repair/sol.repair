// @vitest-environment jsdom

/**
 * How-it-works strip tests for the homepage (page.tsx).
 *
 * The first pre-launch tester (a phone-only Phantom user, relayed by the
 * owner) answered the site with "how do I use this with my wallet". The
 * page pitched the tool and then jumped straight to the wallet button
 * with no first-timer steps between them. The strip that fixes it must
 * always render for a disconnected visitor: four steps, plain language,
 * covering having a wallet, the read-only connect, the scan review, and
 * the fact that nothing happens without a signature.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PublicKey, Connection, Transaction } from "@solana/web3.js";

import Home from "../src/app/page";

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
    connected: false,
    select: vi.fn(),
  },
  scan: {
    loading: false,
    result: null,
    error: null,
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

afterEach(cleanup);

describe("homepage how-it-works strip guides a first-timer", () => {
  it("renders all four steps when no wallet is connected", () => {
    render(<Home />);

    expect(screen.getByText("How it works")).toBeTruthy();
    expect(
      screen.getByText(
        /Have a wallet handy: Phantom, Solflare, or Backpack/
      )
    ).toBeTruthy();
    expect(
      screen.getByText(/Connect read-only\. Tap Select Wallet, pick your wallet/)
    ).toBeTruthy();
    expect(
      screen.getByText(/Review your scan\. The page lists your empty token accounts/)
    ).toBeTruthy();
    expect(
      screen.getByText(/Sign only if you want to claim\. You approve every transaction/)
    ).toBeTruthy();
  });

  it("keeps the owner's writing rules on the strip", () => {
    render(<Home />);

    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(4);
    const text = steps.map((el) => el.textContent ?? "").join(" ");
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});
