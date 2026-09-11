// @vitest-environment jsdom

/**
 * Cannot-do trust lines for the homepage (page.tsx).
 *
 * First-timers answer the page with "how do I use this with my wallet",
 * and the trust half of that question is "what can this site touch".
 * The three lines must stay receipt-backed by how the app actually
 * works: it never asks for a private key or seed phrase, every SOL
 * move is a transaction the wallet owner approves, and accounts whose
 * required on-chain authority is not the owner are skipped, never
 * force-closed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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

describe("homepage cannot-do section is receipt-backed trust copy", () => {
  it("renders all three limits when no wallet is connected", () => {
    render(<Home />);

    expect(screen.getByText("What SOL.repair cannot do")).toBeTruthy();
    expect(
      screen.getByText(/It cannot access your private key or seed phrase/)
    ).toBeTruthy();
    expect(
      screen.getByText(
        /It cannot move your funds without a transaction you approve in your wallet/
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        /It cannot close an account unless the required on-chain authority allows it/
      )
    ).toBeTruthy();
  });

  it("keeps the owner's writing rules and exactly three limits", () => {
    render(<Home />);

    const section = screen
      .getByText("What SOL.repair cannot do")
      .closest("div");
    expect(section).toBeTruthy();
    const lines = within(section as HTMLElement).getAllByRole("listitem");
    expect(lines).toHaveLength(3);
    const text = lines.map((el) => el.textContent ?? "").join(" ");
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});
