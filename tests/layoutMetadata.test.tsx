// @vitest-environment jsdom

/**
 * Metadata copy and architecture tests for layout.tsx.
 *
 * The layout owns three site-wide contracts:
 *  1. The title template ("%s | SOL.repair") that every child page's
 *     bare title flows through, with the homepage title as the default
 *     (the homepage itself is a client page and defines no metadata).
 *  2. The homepage fallback canonical "/" (every other page must
 *     override it with its own path; see routeMetadata.test.tsx).
 *  3. The robots gate: non-mainnet builds ship noindex,nofollow; the
 *     mainnet build ships NO robots meta at all. An explicit
 *     "index, follow" used to conflict with the framework's own
 *     noindex on the not-found page (two robots metas, opposite
 *     meanings), so mainnet now relies on the crawler default.
 *
 * The openGraph and twitter descriptions describe rent with the range
 * wording; pinned so a copy edit cannot silently desync them.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono" }),
}));

vi.mock("@vercel/analytics/react", () => ({
  Analytics: () => null,
}));

import { metadata } from "../src/app/layout";

describe("layout metadata rent wording", () => {
  it("openGraph description carries the range wording", () => {
    expect(metadata.openGraph?.description).toBe(
      "Empty token accounts lock about 0.00149 to 0.00208 SOL each as rent. Close them in a few transactions you sign yourself. Non-custodial, 1% success fee."
    );
  });

  it("twitter description carries the range wording", () => {
    expect(metadata.twitter?.description).toBe(
      "Empty token accounts lock about 0.00149 to 0.00208 SOL each as rent. Close them in a few transactions you sign yourself."
    );
  });
});

describe("layout title template architecture", () => {
  it("default is the homepage title (the homepage defines no metadata of its own)", () => {
    expect(metadata.title).toEqual({
      default: "SOL.repair | Reclaim SOL from Empty Token Accounts",
      template: "%s | SOL.repair",
    });
  });

  it("keeps the homepage fallback canonical", () => {
    expect(metadata.alternates?.canonical).toBe("/");
  });
});

describe("robots gate keeps non-mainnet builds out of search", () => {
  it("noindex,nofollow without the mainnet env var (test default)", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("emits no robots meta at all on mainnet (crawler default is index,follow)", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SOLANA_NETWORK", "mainnet-beta");
    try {
      const { metadata: mainnetMetadata } = await import("../src/app/layout");
      expect(mainnetMetadata.robots).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
