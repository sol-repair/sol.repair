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
import { describe, expect, it, vi } from "vitest";

import sitemap from "@/app/sitemap";

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

function sitemapPaths(): string[] {
  return sitemap()
    .map((entry) => {
      const p = entry.url.replace("https://sol.repair", "");
      return p === "" ? "/" : p;
    })
    .sort();
}

describe("sitemap stays in sync with the app's routes", () => {
  it("lists every page the app serves", () => {
    expect(sitemapPaths()).toEqual(routePaths());
  });

  it("carries a last-modified date and the site base on every entry", () => {
    for (const entry of sitemap()) {
      expect(entry.url.startsWith("https://sol.repair")).toBe(true);
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
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
