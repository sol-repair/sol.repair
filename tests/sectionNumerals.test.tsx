// @vitest-environment jsdom

/**
 * Section-numeral tests for the homepage (page.tsx) and the two
 * homepage section components.
 *
 * The five section numerals (01-05) sit inside h2s. They are visual
 * decoration, so screen readers must hear "How it works", not
 * "01 How it works": every one carries aria-hidden="true", matching
 * the idiom already used on the list-item numerals. The numerals are
 * also the only zinc-600 text left on black below the AA contrast bar
 * (measured 2026-10-16: zinc-600 = 2.72:1, zinc-400 = 8.19:1), so no
 * span inside a rendered heading may carry text-zinc-600 again.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PublicKey, Connection, Transaction } from "@solana/web3.js";

import Home from "../src/app/page";
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
// provide. The section link lists are not under test; render their children.
vi.mock("next/link", () => ({
  default: (props: { children?: unknown }) => props.children,
}));

afterEach(cleanup);

/** The decorative two-digit spans inside rendered h2s: 01 through 05. */
function headingNumerals(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("h2 span")).filter((span) =>
    /^\d{2}$/.test((span.textContent ?? "").trim())
  ) as HTMLElement[];
}

describe("homepage section numerals stay decoration to screen readers", () => {
  it("hides all five section numerals (01-05) from the accessibility tree", () => {
    const { container } = render(<Home />);

    const numerals = headingNumerals(container);
    expect(numerals.map((n) => n.textContent?.trim())).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
    ]);
    for (const numeral of numerals) {
      expect(numeral.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("hears the plain section titles, not the numerals, in the h2s", () => {
    render(<Home />);

    // getByRole walks the accessibility tree, so an aria-hidden numeral
    // or numeral-first heading name fails here. The Example scan h2 is
    // decoration by design and intentionally absent from the tree.
    expect(screen.getByRole("heading", { name: "How it works" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "What SOL.repair cannot do" })
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tools" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Guides" })).toBeTruthy();
  });

  it("carries no text-zinc-600 on any span inside a rendered heading", () => {
    const { container } = render(<Home />);

    const headingSpans = container.querySelectorAll("h1 span, h2 span");
    expect(headingSpans.length).toBeGreaterThan(0);
    for (const span of headingSpans) {
      expect(span.className).not.toContain("text-zinc-600");
    }
  });
});
