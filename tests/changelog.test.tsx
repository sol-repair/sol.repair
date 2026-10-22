// @vitest-environment jsdom

/**
 * The /changelog page and its data list.
 *
 * Future entries are added by hand in later PRs, so the page is
 * optimized for that: one entry in src/lib/changelog.ts is one visible
 * item. These tests pin the contract that must survive hand edits: the
 * data shape, newest-first order, the owner's writing rules, the page
 * rendering every entry, and the link targets in the homepage tools
 * section and footer. The route-derived sitemap and metadata sync tests
 * (sitemapRobots, routeMetadata) cover the rest of the route contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { PublicKey, Connection, Transaction } from "@solana/web3.js";

import { CHANGELOG } from "../src/lib/changelog";
import ChangelogPage from "../src/app/changelog/page";
import Home from "../src/app/page";
import sitemap from "../src/app/sitemap";

afterEach(cleanup);

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
// provide. Render a faithful anchor so the href itself stays assertable
// (the page.footerLink.test.tsx pattern).
vi.mock("next/link", () => ({
  default: (props: { href: string; children?: ReactNode; className?: string }) => (
    <a href={props.href} className={props.className}>
      {props.children}
    </a>
  ),
}));

describe("the changelog data list", () => {
  it("has entries and every entry is complete", () => {
    expect(CHANGELOG.length).toBeGreaterThanOrEqual(8);
    for (const entry of CHANGELOG) {
      expect(/^\d{4}-\d{2}-\d{2}$/.test(entry.date)).toBe(true);
      expect(entry.title.length).toBeGreaterThan(3);
      expect(entry.body.length).toBeGreaterThan(3);
    }
  });

  it("is sorted newest first", () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(CHANGELOG[i].date <= CHANGELOG[i - 1].date).toBe(true);
    }
  });

  it("titles are unique, so one data entry is one visible item", () => {
    const titles = CHANGELOG.map((entry) => entry.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("keeps the owner writing rules on every string", () => {
    for (const entry of CHANGELOG) {
      const text = `${entry.date} ${entry.title} ${entry.body}`;
      expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
      expect(text.includes("!")).toBe(false);
    }
  });
});

describe("the /changelog page", () => {
  it("renders every entry exactly once, in data order", () => {
    const { container } = render(<ChangelogPage />);
    const articles = container.querySelectorAll("article");
    expect(articles.length).toBe(CHANGELOG.length);
    CHANGELOG.forEach((entry, index) => {
      const article = articles[index];
      expect(article.textContent).toContain(entry.date);
      expect(article.textContent).toContain(entry.title);
      expect(article.textContent).toContain(entry.body);
      expect(screen.getAllByText(entry.title).length).toBe(1);
    });
  });

  it("states what the page is, plainly", () => {
    render(<ChangelogPage />);
    expect(screen.getByText(/what shipped on sol\.repair and when/i)).toBeTruthy();
    expect(screen.getByText(/newest first/i)).toBeTruthy();
  });

  it("renders without emdashes, emojis, or exclamation marks", () => {
    const { container } = render(<ChangelogPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[\u2014\u2013]/);
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(text).not.toMatch(/!/);
  });
});

describe("the homepage links to the changelog", () => {
  it("offers the changelog from the tools section and the footer, with the right target", () => {
    render(<Home />);
    const tools = screen.getByRole("link", { name: /product changelog/i });
    expect(tools.getAttribute("href")).toBe("/changelog");
    const footer = screen.getByRole("link", { name: /^changelog$/i });
    expect(footer.getAttribute("href")).toBe("/changelog");
    // Every changelog-named link on the page points at /changelog.
    for (const link of screen.getAllByRole("link", { name: /changelog/i })) {
      expect(link.getAttribute("href")).toBe("/changelog");
    }
  });

  it("describes the page honestly in the tools section", () => {
    render(<Home />);
    expect(
      screen.getByText(/what shipped and when, in plain language/i)
    ).toBeTruthy();
  });
});

describe("the sitemap carries the changelog", () => {
  it("lists /changelog with the tools-class weight", () => {
    const entry = sitemap().find((item) => item.url === "https://sol.repair/changelog");
    expect(entry).toBeDefined();
    expect(entry!.changeFrequency).toBe("weekly");
    expect(entry!.priority).toBe(0.4);
  });
});
