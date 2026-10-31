// @vitest-environment jsdom

/**
 * Rent-copy tests for the homepage (page.tsx).
 *
 * The network lowered the rent rate on 2026-09-04 (SIMD-0437 step 1,
 * mainnet epoch 1028) and lowered it again later (read from the chain
 * 2026-09-14), so a single "~0.002 SOL" figure no longer describes
 * new accounts. The hero rent copy and the example scan card must
 * speak the same range wording as the rent calculator on the guide
 * page: about 0.00149 to 0.00208 SOL, depending on when the accounts
 * were created.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PublicKey, Connection, Transaction } from "@solana/web3.js";

import Home from "../src/app/page";
import { RECOVERED_TOTALS } from "../src/lib/recoveredTotals";
import type { ReactNode } from "react";

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
// provide. The footer links are not under test; render their children.
vi.mock("next/link", () => ({
  default: (props: { children?: unknown }) => props.children,
}));

afterEach(cleanup);

describe("homepage rent copy matches the two-regime reality", () => {
  it("hero tagline states the range, not the old single figure", () => {
    render(<Home />);

    const hero = screen.getByText(
      /Most empty token accounts hold about 0\.00149 to 0\.00208 SOL, depending on when they were created/
    );
    expect(hero).toBeTruthy();
    expect(
      screen.getByText(
        /Recovered SOL is returned to the wallet that owns the account/
      )
    ).toBeTruthy();
    expect(screen.queryByText(/~0\.002 SOL rent/)).toBeNull();
    // The instruction name was library jargon on a first-timer page.
    expect(screen.queryByText(/createCloseAccountInstruction/)).toBeNull();

    // The owner's writing rules hold on the new copy.
    const text = hero.textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });

  it("example scan card spans legacy and current regimes with the corrected total", () => {
    render(<Home />);

    // The approved redesign renders each amount as "recovers X SOL"
    // inside its card.
    expect(screen.getAllByText(/recovers 0\.002039 SOL/).length).toBe(1);
    expect(screen.getAllByText(/recovers 0\.002074 SOL/).length).toBe(1);
    expect(screen.getAllByText(/recovers 0\.001488 SOL/).length).toBe(1);
    expect(
      screen.getByText(/0\.005601 SOL recoverable · 1 transaction/)
    ).toBeTruthy();
    // The old copy led with a plus on a figure that is not a gain.
    expect(screen.queryByText(/\+0\.005934/)).toBeNull();
    expect(screen.queryByText(/0\.005934/)).toBeNull();
  });
});

describe("homepage recovered-to-date line", () => {
  it("renders the weekly counter from the generated constant", () => {
    render(<Home />);

    // Values come from the generated constant, so the Sunday bump can
    // never break this pin: the test reads the same module the page does.
    expect(
      screen.getByText(
        new RegExp(
          `Total SOL recovered through repairs and burn-closes since launch: ${RECOVERED_TOTALS.lamportsFreedSol} SOL\\. As of `
        )
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        new RegExp(`Next weekly update: .+\\. The fee ledger has every row\\.`)
      )
    ).toBeTruthy();

    // The owner's writing rules hold here too.
    const line = screen.getByText(
      /Total SOL recovered through repairs and burn-closes since launch/
    );
    const text = line.textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});
