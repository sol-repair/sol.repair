// @vitest-environment jsdom

/**
 * Homepage footer link to the transaction explainer (M4c).
 *
 * The explainer ships findable: it is in the sitemap and the homepage
 * footer links to it. This test pins the link TARGET, not just its text,
 * by rendering next/link as a faithful anchor, so a silent href drift
 * cannot go unnoticed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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
    simulateTransaction: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
  useConnection: () => ({ connection: mocks.conn as unknown as Connection }),
  // The homepage mounts its Solana provider behind the lazy connect
  // boundary (and /report, /understand at their roots); these
  // passthroughs let the real provider component render with the
  // mocked wallet context underneath.
  ConnectionProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
  WalletProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
}));

vi.mock("@/hooks/useWalletScan", () => ({
  useWalletScan: () => mocks.scan,
}));

// next/link needs the Next.js router context that plain jsdom does not
// provide. Render a faithful anchor so the href itself stays assertable.
vi.mock("next/link", () => ({
  default: (props: { href: string; children?: ReactNode; className?: string }) => (
    <a href={props.href} className={props.className}>
      {props.children}
    </a>
  ),
}));

afterEach(cleanup);

describe("homepage links to the transaction explainer", () => {
  it("offers the explainer from the tools section and the footer with the right target", () => {
    render(<Home />);
    // The explainer is reachable twice: the numbered tools section and
    // the footer. Every match must point at /understand.
    const links = screen.getAllByRole("link", {
      name: /understand a transaction/i,
    });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/understand");
    }
  });

  it("surfaces the explainer in the tools section with the read-only promise", () => {
    render(<Home />);
    expect(screen.getByText("Tools")).toBeTruthy();
    expect(
      screen.getByText(/Paste any signature and read what the transaction did/)
    ).toBeTruthy();
    expect(screen.getByText(/Read-only\./)).toBeTruthy();
  });
});
