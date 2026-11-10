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
    // The wallet-owns-the-account line was removed on the owner's
    // 2026-11-10 ruling; the rent range stands alone.
    expect(
      screen.queryByText(
        /Recovered SOL is returned to the wallet that owns the account/
      )
    ).toBeNull();
    expect(screen.queryByText(/~0\.002 SOL rent/)).toBeNull();
    // The instruction name was library jargon on a first-timer page.
    expect(screen.queryByText(/createCloseAccountInstruction/)).toBeNull();

    // The project writing rules hold on the new copy.
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

describe("homepage fee and transparency lines", () => {
  it("leads with the bold fee line and the transparency line below it", () => {
    const { container } = render(<Home />);

    const paragraphs = Array.from(container.querySelectorAll("p"));
    const feeLine = paragraphs.find(
      (p) =>
        p.textContent === "Only a 1% fee when your SOL actually comes back."
    );
    expect(feeLine).toBeTruthy();
    // The owner's ruling: the same bold the recovered counter displays
    // (the #52 treatment, font-bold text-white).
    expect(feeLine!.className).toContain("font-bold");
    expect(feeLine!.className).toContain("text-white");

    const transparency = paragraphs.find((p) =>
      (p.textContent ?? "").startsWith(
        "As transparent as it gets: every fee lands on chain where anyone can audit it."
      )
    );
    expect(transparency).toBeTruthy();
    // A separate paragraph below the fee line, not the same node.
    expect(
      feeLine!.compareDocumentPosition(transparency!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // The amended sentence: the code-public clause is gone.
    expect(screen.queryByText(/every line of code is public/)).toBeNull();

    // The source link survives on the closing sentence.
    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      (a.textContent ?? "").includes(
        "Verify exactly what the app does in the source code"
      )
    );
    expect(link).toBeTruthy();
    expect(link!.getAttribute("href")).toBe(
      "https://github.com/sol-repair/sol.repair"
    );

    // The writing rules hold on the new copy.
    const text = `${feeLine!.textContent ?? ""} ${transparency!.textContent ?? ""}`;
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});

describe("homepage recovered-to-date line", () => {
  it("renders the weekly counter from the generated constant", () => {
    render(<Home />);

    // Values come from the generated constant, so the Sunday bump can
    // never break this pin: the test reads the same module the page does.
    // The leading sentence is its own styled span; the weekly-update
    // line renders below it after a break (the owner's 2026-11-10
    // layout ruling), and the as-of date no longer renders here.
    expect(
      screen.getByText(
        new RegExp(
          `^Total SOL recovered through repairs and burn-closes: ${RECOVERED_TOTALS.lamportsFreedSol} SOL\\.$`
        )
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        new RegExp(`^Next weekly update: .+\\. The fee ledger has every row\\.$`)
      )
    ).toBeTruthy();
    expect(screen.queryByText(/since launch/)).toBeNull();

    const counterSpan = screen.getByText(
      /Total SOL recovered through repairs and burn-closes:/
    );
    const counterBlock = counterSpan.closest("p");
    expect(counterBlock).toBeTruthy();
    expect(counterBlock!.textContent).not.toContain("As of");
    const br = counterBlock!.querySelector("br");
    expect(br).toBeTruthy();
    // The weekly-update line sits below the counter line, not beside it.
    expect(
      counterSpan.compareDocumentPosition(br!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // The project writing rules hold here too.
    const text = counterSpan.textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});
