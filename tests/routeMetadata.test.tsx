// @vitest-environment jsdom

/**
 * Route metadata sync pins, in the spirit of sitemapRobots.test.ts.
 *
 * The defect this file exists to prevent: a "use client" page cannot
 * export metadata, so it silently inherits the root layout's canonical
 * "/" and homepage title, telling search engines it is a duplicate of
 * the homepage. That exact bug shipped on /fees, /understand, and
 * /report. The rules below are enforced mechanically over every route
 * the app actually serves, derived from the app directory itself so
 * the check grows with the site:
 *
 *  1. Every page except the homepage is a Server Component (no
 *     "use client" at the top of page.tsx) and exports metadata.
 *  2. That metadata's canonical equals the page's own route path.
 *  3. The title is bare (no site-name suffix; the layout template
 *     appends it) and the Open Graph URL/title/description name the
 *     page itself, not the homepage.
 *  4. The owner's writing rules hold on metadata strings too: no
 *     emdashes, no emojis, no exclamation marks.
 *
 * The homepage is the one allowed client page: it is the route the
 * layout fallback metadata describes, which layoutMetadata.test.tsx
 * pins separately.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Metadata } from "next";

// The layout import in the homepage block needs these (same mocks as
// layoutMetadata.test.tsx): next/font/google is a build-time macro and
// must not run for real under vitest.
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono" }),
}));

vi.mock("@vercel/analytics/react", () => ({
  Analytics: () => null,
}));

const APP_DIR = path.resolve(__dirname, "../src/app");
const SITE_ORIGIN = "https://sol.repair";

/** Every route the app serves (directories containing page.tsx). */
function routePages(): { route: string; file: string }[] {
  const routes: { route: string; file: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
      } else if (entry.name === "page.tsx") {
        routes.push({
          route: prefix === "" ? "/" : prefix,
          file: path.join(dir, entry.name),
        });
      }
    }
  };
  walk(APP_DIR, "");
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

/** True when the page file opts into client rendering. */
function isClientPage(file: string): boolean {
  const head = fs.readFileSync(file, "utf8").slice(0, 200).trim();
  return /^["']use client["'];/.test(head);
}

async function loadMetadata(route: string, file: string): Promise<Metadata> {
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.metadata === "undefined") {
    throw new Error(`${route}: page.tsx exports no metadata`);
  }
  return mod.metadata as Metadata;
}

const nonRootPages = routePages().filter((p) => p.route !== "/");

describe("every non-root page owns its metadata", () => {
  it("covers every route the app serves", () => {
    // Fail loudly if the walker ever goes silent: the site has eleven
    // routes today, and a walk bug would vacuously pass every check.
    expect(nonRootPages.length).toBeGreaterThanOrEqual(10);
  });

  for (const { route, file } of nonRootPages) {
    it(`${route} is a server page whose canonical is its own path`, async () => {
      expect(isClientPage(file), "client pages cannot export metadata").toBe(false);
      const metadata = await loadMetadata(route, file);
      expect(metadata.alternates?.canonical).toBe(route);
    });

    it(`${route} carries page-specific titles and Open Graph fields`, async () => {
      const metadata = await loadMetadata(route, file);
      expect(metadata.title).toEqual(expect.any(String));
      const title = metadata.title as string;
      // Bare title: the layout template appends the site name. A
      // pre-suffixed title here would render "| SOL.repair | SOL.repair".
      expect(title.includes("|")).toBe(false);
      expect(title.length).toBeGreaterThan(3);

      expect(metadata.description).toEqual(expect.any(String));
      const description = metadata.description as string;
      expect(description.length).toBeGreaterThanOrEqual(50);
      expect(description.length).toBeLessThanOrEqual(320);

      expect(metadata.openGraph?.url).toBe(`${SITE_ORIGIN}${route}`);
      expect(metadata.openGraph?.title).toBe(`${title} | SOL.repair`);
      expect(metadata.openGraph?.description).toBe(description);
      expect(metadata.twitter?.title).toBe(`${title} | SOL.repair`);
      expect(metadata.twitter?.description).toBe(description);

      // The share-card image lives on the generated /opengraph-image
      // route. Page-level openGraph replaces the root's wholesale, so
      // a page that forgets the image ships a card with no preview
      // (this exact regression happened when the builder was added).
      const images = metadata.openGraph?.images;
      const first = Array.isArray(images) ? images[0] : images;
      if (
        first === undefined ||
        first === null ||
        typeof first === "string" ||
        first instanceof URL
      ) {
        throw new Error("openGraph.images[0] must be a full descriptor");
      }
      expect(first.url).toBe("/opengraph-image");
      expect(first.width).toBe(1200);
      expect(first.height).toBe(630);
      expect(typeof first.alt).toBe("string");
    });

    it(`${route} metadata follows the owner writing rules`, async () => {
      const metadata = await loadMetadata(route, file);
      const text = `${metadata.title ?? ""} ${metadata.description ?? ""}`;
      expect(
        text.includes("\u2014") || text.includes("\u2013"),
        "emdash or endash found in metadata"
      ).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(text), "emoji found").toBe(false);
      expect(text.includes("!"), "exclamation found").toBe(false);
    });
  }
});

describe("the homepage is the one client page, covered by the layout fallback", () => {
  it("is a client page and the layout fallback canonical describes it", async () => {
    const home = routePages().find((p) => p.route === "/");
    expect(home).toBeDefined();
    expect(isClientPage(home!.file)).toBe(true);

    const { metadata } = await import("../src/app/layout");
    expect(metadata.alternates?.canonical).toBe("/");
    expect(metadata.title).toEqual({
      default: "SOL.repair | Reclaim SOL from Empty Token Accounts",
      template: "%s | SOL.repair",
    });
  });
});
