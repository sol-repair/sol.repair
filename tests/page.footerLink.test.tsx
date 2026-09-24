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
  it("offers the explainer from the footer with the right target", () => {
    render(<Home />);
    const link = screen.getByRole("link", {
      name: /understand a transaction/i,
    });
    expect(link.getAttribute("href")).toBe("/understand");
  });

  it("surfaces the explainer in its own section with a working link", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /understand a transaction/i,
      })
    ).toBeTruthy();
    expect(
      screen.getByText(/never asks for an approval/i)
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: /open the explainer/i });
    expect(link.getAttribute("href")).toBe("/understand");
  });
});
