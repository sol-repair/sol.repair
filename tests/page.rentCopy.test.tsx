// @vitest-environment jsdom

/**
 * Rent-copy tests for the homepage (page.tsx).
 *
 * The network lowered the rent rate on 2026-09-04 (SIMD-0437 step 1,
 * mainnet epoch 1028), so a single "~0.002 SOL" figure no longer
 * describes new accounts (they hold 0.00186). The hero tagline and the
 * example scan card must speak the same two-regime range wording as
 * the rent calculator on the guide page: about 0.00186 to 0.00204 SOL
 * per empty account, depending on when it was created.
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

describe("homepage rent copy matches the two-regime reality", () => {
  it("hero tagline states the range, not the old single figure", () => {
    render(<Home />);

    const hero = screen.getByText(
      /return your rent deposits: about 0\.00186 to 0\.00204 SOL per empty account, depending on when it was created/
    );
    expect(hero).toBeTruthy();
    expect(screen.queryByText(/~0\.002 SOL rent/)).toBeNull();

    // The owner's writing rules hold on the new copy.
    const text = hero.textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });

  it("example scan card shows both regimes with the corrected total", () => {
    render(<Home />);

    expect(screen.getAllByText("0.002039 SOL")).toHaveLength(2);
    expect(screen.getAllByText("0.001856 SOL")).toHaveLength(1);
    expect(
      screen.getByText(/\+0\.005934 SOL recoverable · 1 transaction/)
    ).toBeTruthy();
    expect(screen.queryByText(/\+0\.006117/)).toBeNull();
  });
});
