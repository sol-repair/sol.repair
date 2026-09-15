// @vitest-environment jsdom

/**
 * Metadata copy tests for layout.tsx.
 *
 * The openGraph and twitter descriptions describe rent with the old
 * single "~0.002 SOL" figure. After the rate cuts, the descriptions
 * carry the same range wording as the homepage tagline: about 0.00149
 * to 0.00208 SOL each.
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
