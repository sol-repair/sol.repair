// @vitest-environment jsdom

/**
 * The /guides/repair-transaction guide.
 *
 * Jobs, in order:
 *  1. The page renders with its headline, its load-bearing claims, and
 *     its internal links.
 *  2. THE ANTI-DRIFT PINS: every number the page states that has a
 *     shipped constant is asserted against the constant itself,
 *     imported from the source module, so the page physically cannot
 *     drift from the code. Numbers with no constant (the byte budget,
 *     the wire tags) are pinned against the shipped source comments
 *     that state them, so either side moving alone fails here.
 *  3. The owner's writing rules hold mechanically on the new strings.
 *  4. The registry entry, the guides index, and the homepage section
 *     all include the guide.
 *  5. Breadcrumb, table of contents, and JSON-LD follow the guide
 *     conventions the other six pages share.
 */

import fs from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import RepairTransactionGuide from "@/app/guides/repair-transaction/page";
import GuidesIndexPage from "@/app/guides/page";
import GuidesSection from "@/components/GuidesSection";
import { GUIDES } from "@/lib/guides";
import {
  estimateNetworkFee,
  MAX_CLOSE_INSTRUCTIONS_PER_TX,
} from "@/lib/solana/transactions";
import { FEE_PERCENT, feeAmountLamports } from "@/lib/solana/fees";
import { WITHDRAW_EXCESS_LAMPORTS_TAG } from "@/lib/solana/excessLamports";
import { TOKEN_ACCOUNT_RENT_LAMPORTS_CURRENT } from "@/lib/rent";
import type { ClosableAccount } from "@/lib/solana/tokenAccounts";

const SRC = path.resolve(__dirname, "../src");

/** The example batch the page renders its arithmetic from: one
 *  current-rent account, and a full batch of them. */
const exampleAccount: ClosableAccount = {
  pubkey: "example",
  mint: "example",
  lamports: TOKEN_ACCOUNT_RENT_LAMPORTS_CURRENT,
  program: "spl",
};
const fullBatch: ClosableAccount[] = Array.from(
  { length: MAX_CLOSE_INSTRUCTIONS_PER_TX },
  () => exampleAccount
);

const fmt = (value: bigint | number): string =>
  Number(value).toLocaleString("en-US");

/** A number extracted from a shipped source comment, or null. */
function sourceNumber(file: string, pattern: RegExp): number | null {
  const text = fs.readFileSync(path.join(SRC, file), "utf8");
  const match = text.match(pattern);
  return match ? parseInt(match[1], match[1].startsWith("0x") ? 16 : 10) : null;
}

function renderGuide() {
  return render(<RepairTransactionGuide />);
}

afterEach(cleanup);

describe("the repair transaction guide renders", () => {
  it("carries its headline and its load-bearing claims", () => {
    const { container } = renderGuide();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /the transaction the repair tool builds/i,
      })
    ).toBeTruthy();
    // This sentence spans a link, so it is checked against the whole
    // text content rather than a single text node.
    expect(container.textContent).toMatch(
      /announced in the site's changelog first/i
    );
    expect(
      screen.getByText(/the destination is always your own wallet/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/nothing on chain requires a custom client to pay it/i)
    ).toBeTruthy();
    expect(screen.getByText(/burning permanently destroys/i)).toBeTruthy();
  });

  it("links the changelog, the fee ledger, the explainer, and the context guides", () => {
    const { container } = renderGuide();
    const hrefs = Array.from(
      container.querySelectorAll('a[href^="/"]')
    ).map((a) => a.getAttribute("href"));
    for (const href of [
      "/changelog",
      "/fees",
      "/understand",
      "/guides/solana-rent",
      "/guides/token-approvals",
    ]) {
      expect(hrefs).toContain(href);
    }
  });
});

describe("every page number matches the constant it renders from", () => {
  it("renders the batching cap from MAX_CLOSE_INSTRUCTIONS_PER_TX", () => {
    const { container } = renderGuide();
    const text = container.textContent ?? "";
    expect(text).toContain(`caps batches at ${MAX_CLOSE_INSTRUCTIONS_PER_TX}`);
    expect(text).toContain(`stop at ${MAX_CLOSE_INSTRUCTIONS_PER_TX}`);
    expect(text).toContain(`batch of ${MAX_CLOSE_INSTRUCTIONS_PER_TX}`);
  });

  it("renders the fee percent from FEE_PERCENT", () => {
    const { container } = renderGuide();
    const text = container.textContent ?? "";
    expect(text).toContain(`fee of ${FEE_PERCENT} percent`);
    expect(text).toContain(`${FEE_PERCENT} percent, floored, is`);
  });

  it("renders the fee example from feeAmountLamports and the rent constant", () => {
    const { container } = renderGuide();
    const text = container.textContent ?? "";
    const singleFee = feeAmountLamports([exampleAccount]);
    const batchRent = fullBatch.reduce((sum, a) => sum + BigInt(a.lamports), 0n);
    const batchFee = feeAmountLamports(fullBatch);
    expect(text).toContain(`holds ${fmt(TOKEN_ACCOUNT_RENT_LAMPORTS_CURRENT)} lamports`);
    expect(text).toContain(`is ${fmt(singleFee)} lamports`);
    expect(text).toContain(`returns ${fmt(batchRent)} lamports`);
    expect(text).toContain(`pays ${fmt(batchFee)}`);
  });

  it("renders the network fee from estimateNetworkFee", () => {
    const { container } = renderGuide();
    expect(container.textContent).toContain(
      `${fmt(estimateNetworkFee())} lamports per signature`
    );
  });

  it("renders the withdrawal tag from WITHDRAW_EXCESS_LAMPORTS_TAG", () => {
    const { container } = renderGuide();
    expect(
      new RegExp(`instruction ${WITHDRAW_EXCESS_LAMPORTS_TAG}\\b`).test(
        container.textContent ?? ""
      )
    ).toBe(true);
  });
});

describe("numbers without a constant stay pinned to the shipped source", () => {
  it("byte budget matches the transactions.ts comment", () => {
    const packetLimit = sourceNumber(
      "lib/solana/transactions.ts",
      /limited to (\d+) bytes/
    );
    const perClose = sourceNumber(
      "lib/solana/transactions.ts",
      /costs ~(\d+) bytes/
    );
    const roughlyFit = sourceNumber(
      "lib/solana/transactions.ts",
      /roughly (\d+) fit/
    );
    expect(packetLimit).not.toBeNull();
    expect(perClose).not.toBeNull();
    expect(roughlyFit).not.toBeNull();
    const { container } = renderGuide();
    const text = container.textContent ?? "";
    expect(text).toContain(`${fmt(packetLimit as number)} bytes`);
    expect(text).toContain(`about ${perClose} bytes`);
    expect(text).toContain(`about ${roughlyFit} of them fit`);
  });

  it("wire tags match the tags the source modules state", () => {
    const revokeTag = sourceNumber(
      "lib/solana/revokeDelegation.ts",
      /wire tag (0x[0-9a-fA-F]+)/
    );
    const closeTag = sourceNumber(
      "lib/solana/unwrapNative.ts",
      /wire tag (0x[0-9a-fA-F]+)/
    );
    expect(revokeTag).not.toBeNull();
    expect(closeTag).not.toBeNull();
    const { container } = renderGuide();
    const text = container.textContent ?? "";
    expect(text).toContain(`CloseAccount is instruction ${closeTag}`);
    expect(text).toContain(`Revoke is instruction ${revokeTag}`);
  });
});

describe("owner writing rules hold on the new strings", () => {
  it("no em dashes, en dashes, emojis, or exclamation marks on the page", () => {
    const { container } = renderGuide();
    const text = container.textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });

  it("no em dashes, en dashes, emojis, or exclamation marks in the registry entry", () => {
    const entry = GUIDES.find((g) => g.href === "/guides/repair-transaction");
    expect(entry).toBeDefined();
    const text = `${entry?.title ?? ""} ${entry?.summary ?? ""}`;
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});

describe("the registry, the index, and the homepage include the guide", () => {
  it("registry holds seven guides with the new one seventh, flagship first", () => {
    expect(GUIDES).toHaveLength(7);
    expect(GUIDES[GUIDES.length - 1]?.href).toBe("/guides/repair-transaction");
    expect(GUIDES[0]?.href).toBe("/guides/close-token-accounts");
  });

  it("guides index links the new guide", () => {
    render(<GuidesIndexPage />);
    expect(
      document.querySelector('a[href="/guides/repair-transaction"]')
    ).not.toBeNull();
  });

  it("homepage guides section links the new guide", () => {
    render(<GuidesSection />);
    expect(
      document.querySelector('a[href="/guides/repair-transaction"]')
    ).not.toBeNull();
  });
});

describe("breadcrumb, table of contents, and JSON-LD follow the guide conventions", () => {
  it("breadcrumb mirrors the headline and the JSON-LD mirrors both", () => {
    const { container } = renderGuide();
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav.querySelector('a[href="/guides"]')?.textContent).toBe("Guides");
    const current = nav.querySelector('[aria-current="page"]');
    expect(current?.textContent).toBe(
      screen.getByRole("heading", { level: 1 }).textContent
    );

    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const parsed = JSON.parse(script?.textContent ?? "null");
    const types = parsed.map((node: { "@type": string }) => node["@type"]);
    expect(types.sort()).toEqual(["BreadcrumbList", "TechArticle"]);
    const breadcrumb = parsed.find(
      (node: { "@type": string }) => node["@type"] === "BreadcrumbList"
    );
    const article = parsed.find(
      (node: { "@type": string }) => node["@type"] === "TechArticle"
    );
    expect(breadcrumb.itemListElement).toHaveLength(2);
    expect(breadcrumb.itemListElement[1].name).toBe(current?.textContent);
    expect(breadcrumb.itemListElement[1].item).toBe(article.url);
    expect(article.headline).toBe(
      screen.getByRole("heading", { level: 1 }).textContent
    );
    expect(article.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(article.dateModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(article.dateModified >= article.datePublished).toBe(true);
  });

  it("the table of contents lists every section heading in order", () => {
    const { container } = renderGuide();
    const toc = screen.getByRole("navigation", { name: "On this page" });
    const tocHrefs = Array.from(toc.querySelectorAll("a")).map((a) =>
      a.getAttribute("href")
    );
    const headingIds = Array.from(container.querySelectorAll("h2")).map(
      (h) => `#${h.id}`
    );
    expect(tocHrefs.length).toBeGreaterThan(0);
    expect(tocHrefs).toEqual(headingIds);
    for (const id of headingIds) {
      expect(
        document.getElementById(id.replace(/^#/, "")),
        `missing anchor ${id}`
      ).not.toBeNull();
    }
  });
});
