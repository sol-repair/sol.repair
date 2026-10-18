// @vitest-environment node

/**
 * Sync pins for the sitemap and robots routes.
 *
 * The sitemap must list every public page: a route that ships without a
 * sitemap entry is invisible to crawlers that trust the map (this exact
 * gap happened when the guides grew). The expected set is derived from
 * the app directory itself, so the check grows with the site instead of
 * hardcoding today's routes. Robots must keep non-mainnet builds out of
 * search results, gated on the same env var the app reads.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import sitemap from "@/app/sitemap";
import { LAST_MODIFIED } from "@/lib/sitemapDates";

const APP_DIR = path.resolve(__dirname, "../src/app");

/** Every route the app actually serves: directories containing page.tsx. */
function routePaths(): string[] {
  const routes: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
      } else if (entry.name === "page.tsx") {
        routes.push(prefix === "" ? "/" : prefix);
      }
    }
  };
  walk(APP_DIR, "");
  return routes.sort();
}

/** Routes that are deliberately NOT in the sitemap yet. Every entry needs
 *  a reason; when a page goes public it joins the sitemap and leaves this
 *  list in the same commit. Empty today: the explainer went public in
 *  M4c, so every route now belongs in the map. */
const INTENTIONALLY_UNLISTED: string[] = [];

function sitemapPaths(): string[] {
  return sitemap()
    .map((entry) => {
      const p = entry.url.replace("https://sol.repair", "");
      return p === "" ? "/" : p;
    })
    .sort();
}

describe("sitemap stays in sync with the app's routes", () => {
  it("lists every page the app serves, except the declared quiet routes", () => {
    expect(sitemapPaths()).toEqual(
      routePaths().filter((route) => !INTENTIONALLY_UNLISTED.includes(route))
    );
  });

  it("carries a last-modified date and the site base on every entry", () => {
    for (const entry of sitemap()) {
      expect(entry.url.startsWith("https://sol.repair")).toBe(true);
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
  });

  it("returns deep-equal lastModified values across calls (no deploy-time churn)", async () => {
    const first = sitemap();
    // Under the old new Date() behavior the second call's stamps always
    // differ from the first's; the pause makes that red deterministic
    // instead of same-millisecond flaky.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = sitemap();
    expect(second.map((entry) => entry.lastModified)).toEqual(
      first.map((entry) => entry.lastModified)
    );
  });

  it("has a static date record entry for every sitemap URL and vice versa", () => {
    expect(Object.keys(LAST_MODIFIED).sort()).toEqual(sitemapPaths());
  });
});

/**
 * The git-history floor for sitemap dates, re-derived at test time.
 *
 * A page's content lives in every file under its route directory (the
 * fees page's wording is in fees-client.tsx, not its page.tsx), so the
 * mapping below points at directories, not page files alone; "/" uses
 * src/app/page.tsx by itself because src/app/ also holds the layout,
 * sitemap, and icon files that are not homepage content. /changelog
 * additionally considers its data file, which drives the page.
 *
 * The assertion is one-directional on purpose: record >= git. A date
 * overstated by a little only costs a crawler a re-visit; a date
 * understated tells crawlers a changed page is unchanged, which is the
 * trust-killer the static record exists to prevent.
 */
const CONTENT_PATHS: Record<string, string[]> = {
  "/": ["src/app/page.tsx"],
  "/fees": ["src/app/fees"],
  "/understand": ["src/app/understand"],
  "/report": ["src/app/report"],
  "/changelog": ["src/app/changelog", "src/lib/changelog.ts"],
  "/guides/random-tokens": ["src/app/guides/random-tokens"],
  "/guides/rent-reduction": ["src/app/guides/rent-reduction"],
  "/guides/solana-rent": ["src/app/guides/solana-rent"],
  "/guides/token-approvals": ["src/app/guides/token-approvals"],
  "/guides/close-token-accounts": ["src/app/guides/close-token-accounts"],
  "/guides/what-did-i-just-sign": ["src/app/guides/what-did-i-just-sign"],
  "/guides": ["src/app/guides"],
  "/terms": ["src/app/terms"],
  "/privacy": ["src/app/privacy"],
};

/** Last commit date (YYYY-MM-DD) that touched a content path, or null
 *  when git answers nothing for it. The empty answer is the
 *  second-layer guard behind the shallow check above: a path git
 *  cannot read in this checkout is skipped, not failed. */
function lastContentCommitDate(contentPath: string): string | null {
  try {
    const out = execSync(`git log -1 --format=%cs -- "${contentPath}"`, {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** True when this checkout's history is not full. */
function checkoutIsShallow(): boolean {
  try {
    return (
      execSync("git rev-parse --is-shallow-repository", {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

describe("sitemap dates never understate the content's git history", () => {
  it("states no lastmod older than any content path's last commit", () => {
    // On a shallow checkout this pin's evidence is untrustworthy in
    // both directions: history past the tip is missing, and - the real
    // trap - the grafted root commit marks every existing file as
    // added at the tip, so `git log -- <path>` matches the tip and
    // returns the tip's date for every path, never empty. A shallow
    // checkout anywhere skips the floor for the whole run; the
    // empty-output guard below stays as a second layer.
    if (checkoutIsShallow()) {
      console.warn("shallow checkout: skipping the sitemap git-floor pin");
      return;
    }
    const understated: string[] = [];
    for (const [route, contentPaths] of Object.entries(CONTENT_PATHS)) {
      const dates = contentPaths
        .map(lastContentCommitDate)
        .filter((date): date is string => date !== null);
      if (dates.length === 0) continue;
      const truth = dates.reduce((a, b) => (a > b ? a : b));
      const record = LAST_MODIFIED[route];
      if (record === undefined || record < truth) {
        understated.push(
          `${route}: record ${record ?? "missing"} < git ${truth}`
        );
      }
    }
    expect(understated).toEqual([]);
  });
});

describe("robots keeps non-mainnet builds out of search results", () => {
  it("disallows everything without the mainnet env var (test default)", async () => {
    vi.resetModules();
    const { default: robots } = await import("@/app/robots");
    const policy = robots();
    expect(policy.rules).toEqual({ userAgent: "*", disallow: "/" });
    expect(policy.sitemap).toBeUndefined();
  });

  it("allows crawling and points at the sitemap on mainnet", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SOLANA_NETWORK", "mainnet-beta");
    const { default: robots } = await import("@/app/robots");
    const policy = robots();
    expect(policy.rules).toEqual({ userAgent: "*", allow: "/" });
    expect(policy.sitemap).toBe("https://sol.repair/sitemap.xml");
    vi.unstubAllEnvs();
  });
});
