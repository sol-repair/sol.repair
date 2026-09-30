// @vitest-environment jsdom

/**
 * Render tests for the guide pages.
 *
 * Jobs, in order:
 *  1. Each guide renders with its question-shaped headline and its
 *     honest key claims (the numbers and scope sentences a reader
 *     relies on).
 *  2. Every guide carries the visible Guides breadcrumb, and its
 *     JSON-LD (BreadcrumbList + TechArticle) mirrors what is visible:
 *     same title, same path, honest ISO dates.
 *  3. Every internal link inside a guide resolves to a route the app
 *     actually serves (walked from src/app, the way the sitemap test
 *     does), so no guide can ship a dead link.
 *  4. The owner's writing rules hold mechanically: no emdashes, no
 *     emojis, no cussing in the public copy. A test fails if any of
 *     that slips in.
 */

import fs from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import RandomTokensGuide from "@/app/guides/random-tokens/page";
import SolanaRentGuide from "@/app/guides/solana-rent/page";
import CloseTokenAccountsGuide from "@/app/guides/close-token-accounts/page";
import WhatDidIJustSignGuide from "@/app/guides/what-did-i-just-sign/page";
import TokenApprovalsGuide from "@/app/guides/token-approvals/page";
import RentReductionGuide from "@/app/guides/rent-reduction/page";
import GuidesIndexPage from "@/app/guides/page";
import GuidesSection from "@/components/GuidesSection";
import { GUIDES } from "@/lib/guides";

const PAGES = [
  { name: "random-tokens", Component: RandomTokensGuide },
  { name: "solana-rent", Component: SolanaRentGuide },
  { name: "close-token-accounts", Component: CloseTokenAccountsGuide },
  { name: "what-did-i-just-sign", Component: WhatDidIJustSignGuide },
  { name: "token-approvals", Component: TokenApprovalsGuide },
  { name: "rent-reduction", Component: RentReductionGuide },
  { name: "guides index", Component: GuidesIndexPage },
  { name: "guides section", Component: GuidesSection },
];

const APP_DIR = path.resolve(__dirname, "../src/app");

/** Every route the app serves; internal links must stay inside it. */
function knownRoutes(): Set<string> {
  const routes = new Set<string>(["/"]);
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
      } else if (entry.name === "page.tsx") {
        routes.add(prefix === "" ? "/" : prefix);
      }
    }
  };
  walk(APP_DIR, "");
  return routes;
}

/** All internal hrefs (leading slash) rendered inside a container. */
function internalHrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('a[href^="/"]')).map(
    (a) => a.getAttribute("href") as string
  );
}

/** Assert a link to an internal route exists, without caring how many
 *  anchors carry it (in-section and footer links often repeat). */
function expectLinkTo(href: string) {
  expect(
    document.querySelector(`a[href="${href}"]`),
    `missing link to ${href}`
  ).not.toBeNull();
}

afterEach(cleanup);

describe("guide pages render with their content", () => {
  it("what did I just sign guide explains instructions and lasting permissions", () => {
    render(<WhatDidIJustSignGuide />);
    expect(
      screen.getByRole("heading", { level: 1, name: /what did i just sign/i })
    ).toBeTruthy();
    expect(
      screen.getByText(/the network runs them in order/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/last is not what a transaction did for you, but what it left behind/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/Wallets add their own instructions when you sign/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/it describes, it does not accuse/i)
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /open the explainer/i })
    ).toBeTruthy();
    expectLinkTo("/guides/token-approvals");
  });

  it("random tokens guide answers the question in its headline", () => {
    render(<RandomTokensGuide />);
    expect(
      screen.getByRole("heading", { level: 1, name: /random tokens/i })
    ).toBeTruthy();
    expect(screen.getByText(/2,039,280/)).toBeTruthy();
    expect(screen.getByText(/1,855,569/)).toBeTruthy();
    expect(screen.getByText(/skipped and kept safe/)).toBeTruthy();
    expectLinkTo("/guides/close-token-accounts");
  });

  it("rent guide explains the deposit and carries the calculator", () => {
    render(<SolanaRentGuide />);
    expect(
      screen.getByRole("heading", { level: 1, name: /what is solana rent/i })
    ).toBeTruthy();
    expect(screen.getByText(/deposit, not a fee/i)).toBeTruthy();
    expect(screen.getByLabelText(/empty token accounts/i)).toBeTruthy();
    expect(screen.getByText(/0.0203928 SOL/)).toBeTruthy();
    expect(screen.getByText(/0.0148844/)).toBeTruthy();
    expect(screen.getByText(/1,855,569/)).toBeTruthy();
    expect(screen.getByText(/1,488,440/)).toBeTruthy();
    expect(screen.getByText(/Mainnet lowered it on September 4, 2026/)).toBeTruthy();
    expect(
      screen.getByText(/holds about 0\.00149 to 0\.00208 SOL of rent/)
    ).toBeTruthy();
    expect(screen.queryByText(/holds about 0\.002 SOL of rent/)).toBeNull();
    expectLinkTo("/guides/rent-reduction");
  });

  it("close guide covers the three routes, the special cases, and the safety checks", () => {
    render(<CloseTokenAccountsGuide />);
    expect(
      screen.getByRole("heading", { level: 1, name: /close empty token/i })
    ).toBeTruthy();
    expect(screen.getByText(/Three ways to do it/)).toBeTruthy();
    expect(
      screen.getByText(/spl-token gc --close-empty-associated-accounts/)
    ).toBeTruthy();
    expect(screen.getAllByText(/Token-2022/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Wrapped SOL/).length).toBeGreaterThan(0);
    expect(screen.getByText(/at most five approval popups/)).toBeTruthy();
    expect(screen.getByText(/never touches a token balance/i)).toBeTruthy();
    expect(screen.getByText(/One percent of what you recover/i)).toBeTruthy();
    expect(screen.getByText(/See the fee ledger/i)).toBeTruthy();
    expectLinkTo("/guides/token-approvals");
    expectLinkTo("/guides/rent-reduction");
    expectLinkTo("/guides/solana-rent");
    expectLinkTo("/report");
    expectLinkTo("/fees");
  });

  it("token approvals guide states powers, limits, and the site's exact scope", () => {
    render(<TokenApprovalsGuide />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /how to check and revoke solana token approvals/i,
      })
    ).toBeTruthy();
    expect(
      screen.getByText(/transfer or burn tokens from that one account/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/cannot move SOL or any token from your other token/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/Disconnecting a site cannot change on-chain data/i)
    ).toBeTruthy();
    expect(screen.getByText(/listed read-only/)).toBeTruthy();
    expect(screen.getByText(/revoke plus close together/i)).toBeTruthy();
    expect(
      document.querySelector('a[href="https://revoke.cash"]')
    ).not.toBeNull();
    expect(
      document.querySelector('a[href="https://sol-incinerator.com/revoke"]')
    ).not.toBeNull();
    expectLinkTo("/understand");
    expectLinkTo("/report");
    expectLinkTo("/guides/close-token-accounts");
    expectLinkTo("/guides/what-did-i-just-sign");
  });

  it("rent reduction guide carries the verified schedule and program split", () => {
    render(<RentReductionGuide />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /rent cuts and the sol above the new minimum/i,
      })
    ).toBeTruthy();
    expect(screen.getAllByText(/SIMD-0437/).length).toBeGreaterThan(0);
    // Rates and dates appear in both the prose and the schedule table.
    expect(screen.getAllByText(/6,960/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/6,333/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/5,080/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2,575/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1,322/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/696/).length).toBeGreaterThan(0);
    expect(screen.getByText(/2,039,280/)).toBeTruthy();
    expect(screen.getByText(/1,855,569/)).toBeTruthy();
    expect(screen.getByText(/1,488,440/)).toBeTruthy();
    expect(screen.getByText(/754,475/)).toBeTruthy();
    expect(screen.getByText(/387,346/)).toBeTruthy();
    expect(screen.getByText(/203,928/)).toBeTruthy();
    expect(screen.getAllByText(/September 4, 2026/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/September 14, 2026/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/WithdrawExcessLamports/)
    ).toBeTruthy();
    expect(
      screen.getByText(/The classic Token Program has no such instruction/i)
    ).toBeTruthy();
    expectLinkTo("/guides/close-token-accounts");
    expectLinkTo("/guides/solana-rent");
    expectLinkTo("/fees");
    expectLinkTo("/report");
  });

  it("guides index links every published guide from the registry", () => {
    render(<GuidesIndexPage />);
    for (const guide of GUIDES) {
      expect(
        document.querySelector(`a[href="${guide.href}"]`)
      ).not.toBeNull();
    }
  });

  it("guides section on the home page links every published guide", () => {
    render(<GuidesSection />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Guides" })
    ).toBeTruthy();
    for (const guide of GUIDES) {
      expect(document.querySelector(`a[href="${guide.href}"]`)).not.toBeNull();
    }
  });
});

describe("every guide carries a visible breadcrumb that matches its schema", () => {
  const GUIDE_PAGE_NAMES = [
    "random-tokens",
    "solana-rent",
    "close-token-accounts",
    "what-did-i-just-sign",
    "token-approvals",
    "rent-reduction",
  ];
  const GUIDE_PAGES = PAGES.filter((p) =>
    GUIDE_PAGE_NAMES.includes(p.name)
  );

  it("covers all six guides", () => {
    expect(GUIDE_PAGES.length).toBe(6);
  });

  for (const { name, Component } of GUIDE_PAGES) {
    it(`${name} breadcrumb and BreadcrumbList agree`, () => {
      const { container } = render(<Component />);
      const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
      expect(nav.querySelector('a[href="/guides"]')?.textContent).toBe(
        "Guides"
      );
      const current = nav.querySelector('[aria-current="page"]');
      expect(current?.textContent).toBe(
        screen.getByRole("heading", { level: 1 }).textContent
      );

      const script = container.querySelector(
        'script[type="application/ld+json"]'
      );
      expect(script).not.toBeNull();
      const parsed = JSON.parse(script?.textContent ?? "null");
      expect(Array.isArray(parsed)).toBe(true);
      const breadcrumb = parsed.find(
        (node: { "@type": string }) => node["@type"] === "BreadcrumbList"
      );
      const article = parsed.find(
        (node: { "@type": string }) => node["@type"] === "TechArticle"
      );
      expect(breadcrumb.itemListElement).toHaveLength(2);
      expect(breadcrumb.itemListElement[0].name).toBe("Guides");
      expect(breadcrumb.itemListElement[0].item).toBe(
        "https://sol.repair/guides"
      );
      expect(breadcrumb.itemListElement[1].name).toBe(current?.textContent);
      // The breadcrumb's last item is the page's own canonical URL,
      // and the article describes the same URL.
      expect(breadcrumb.itemListElement[1].item).toMatch(
        /^https:\/\/sol\.repair\/guides\/[a-z0-9-]+$/
      );
      expect(breadcrumb.itemListElement[1].item).toBe(article.url);
    });

    it(`${name} TechArticle schema describes the visible page honestly`, () => {
      const { container } = render(<Component />);
      const parsed = JSON.parse(
        container.querySelector('script[type="application/ld+json"]')
          ?.textContent ?? "null"
      );
      const article = parsed.find(
        (node: { "@type": string }) => node["@type"] === "TechArticle"
      );
      expect(article.headline).toBe(
        screen.getByRole("heading", { level: 1 }).textContent
      );
      expect(article.url.startsWith("https://sol.repair/guides/")).toBe(true);
      expect(article.author.name).toBe("SOL.repair");
      expect(article.publisher.name).toBe("SOL.repair");
      // Real dates in ISO form, modified never earlier than published.
      expect(article.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(article.dateModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(article.dateModified >= article.datePublished).toBe(true);
      // No schema types beyond the two the guides actually carry.
      const types = parsed.map((node: { "@type": string }) => node["@type"]);
      expect(types.sort()).toEqual(["BreadcrumbList", "TechArticle"]);
    });
  }
});

describe("internal links in guides resolve to routes the app serves", () => {
  const routes = knownRoutes();

  for (const { name, Component } of PAGES) {
    it(`${name} has no dead internal links`, () => {
      const { container } = render(<Component />);
      for (const href of internalHrefs(container)) {
        expect(routes.has(href), `unknown route ${href}`).toBe(true);
      }
    });
  }
});

describe("owner writing rules hold mechanically", () => {
  it("no emdashes anywhere in the guide copy", () => {
    for (const { Component } of PAGES) {
      const { container } = render(<Component />);
      const text = container.textContent ?? "";
      expect(
        text.includes("\u2014") || text.includes("\u2013"),
        "emdash or endash found in rendered copy"
      ).toBe(false);
    }
  });

  it("no emojis anywhere in the guide copy", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const { name, Component } of PAGES) {
      const { container } = render(<Component />);
      const text = container.textContent ?? "";
      expect(emoji.test(text), `emoji found in ${name}`).toBe(false);
    }
  });

  it("no exclamation marks in the guide copy", () => {
    for (const { name, Component } of PAGES) {
      const { container } = render(<Component />);
      const text = container.textContent ?? "";
      expect(text.includes("!"), `exclamation found in ${name}`).toBe(false);
    }
  });
});

describe("the guide list is a single source", () => {
  it("holds exactly the six published guides, flagship first", () => {
    expect(GUIDES.map((g) => g.href)).toEqual([
      "/guides/close-token-accounts",
      "/guides/solana-rent",
      "/guides/rent-reduction",
      "/guides/token-approvals",
      "/guides/random-tokens",
      "/guides/what-did-i-just-sign",
    ]);
    for (const guide of GUIDES) {
      expect(guide.title.length).toBeGreaterThan(0);
      expect(guide.summary.length).toBeGreaterThan(0);
    }
  });

  it("holds the owner's writing rules on the raw strings", () => {
    const text = GUIDES.map((g) => `${g.title} ${g.summary}`).join(" ");
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });

  it("every registry entry points at a route the app serves", () => {
    const routes = knownRoutes();
    for (const guide of GUIDES) {
      expect(routes.has(guide.href), `unknown route ${guide.href}`).toBe(true);
    }
  });
});
