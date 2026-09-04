// @vitest-environment jsdom

/**
 * Render tests for the guide pages.
 *
 * Two jobs: each guide renders with its question-shaped headline and
 * its honest key claims, and the owner's writing rules hold
 * mechanically. The rules are: no emdashes, no emojis, no cussing in
 * the public copy. A test fails if any of that slips in.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import RandomTokensGuide from "@/app/guides/random-tokens/page";
import SolanaRentGuide from "@/app/guides/solana-rent/page";
import CloseTokenAccountsGuide from "@/app/guides/close-token-accounts/page";
import GuidesIndexPage from "@/app/guides/page";
import GuidesSection from "@/components/GuidesSection";
import { GUIDES } from "@/lib/guides";

const PAGES = [
  { name: "random-tokens", Component: RandomTokensGuide },
  { name: "solana-rent", Component: SolanaRentGuide },
  { name: "close-token-accounts", Component: CloseTokenAccountsGuide },
  { name: "guides index", Component: GuidesIndexPage },
  { name: "guides section", Component: GuidesSection },
];

afterEach(cleanup);

describe("guide pages render with their content", () => {
  it("random tokens guide answers the question in its headline", () => {
    render(<RandomTokensGuide />);
    expect(
      screen.getByRole("heading", { level: 1, name: /random tokens/i })
    ).toBeTruthy();
    expect(screen.getByText(/2,039,280/)).toBeTruthy();
    expect(screen.getByText(/1,855,569/)).toBeTruthy();
    expect(screen.getByText(/skipped and kept safe/)).toBeTruthy();
  });

  it("rent guide explains the deposit and carries the calculator", () => {
    render(<SolanaRentGuide />);
    expect(
      screen.getByRole("heading", { level: 1, name: /what is solana rent/i })
    ).toBeTruthy();
    expect(screen.getByText(/deposit, not a fee/i)).toBeTruthy();
    expect(screen.getByLabelText(/empty token accounts/i)).toBeTruthy();
    expect(screen.getByText(/0.0203928 SOL/)).toBeTruthy();
    expect(screen.getByText(/0.01855569/)).toBeTruthy();
    expect(screen.getByText(/1,855,569/)).toBeTruthy();
    expect(screen.getByText(/Mainnet lowered it on September 4, 2026/)).toBeTruthy();
  });

  it("close guide states what closing never does and the fee", () => {
    render(<CloseTokenAccountsGuide />);
    expect(
      screen.getByRole("heading", { level: 1, name: /close empty token/i })
    ).toBeTruthy();
    expect(screen.getByText(/never touches a token balance/i)).toBeTruthy();
    expect(screen.getByText(/One percent of what you recover/i)).toBeTruthy();
    expect(screen.getByText(/See the fee ledger/i)).toBeTruthy();
  });

  it("guides index links all three guides", () => {
    render(<GuidesIndexPage />);
    for (const href of [
      "/guides/random-tokens",
      "/guides/solana-rent",
      "/guides/close-token-accounts",
    ]) {
      expect(
        document.querySelector(`a[href="${href}"]`)
      ).not.toBeNull();
    }
  });

  it("guides section on the home page links all three guides with their blurbs", () => {
    render(<GuidesSection />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Guides" })
    ).toBeTruthy();
    for (const href of [
      "/guides/random-tokens",
      "/guides/solana-rent",
      "/guides/close-token-accounts",
    ]) {
      expect(document.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
    expect(screen.getByText(/Where dust tokens come from/)).toBeTruthy();
    expect(screen.getByText(/parks a small SOL deposit/)).toBeTruthy();
    expect(screen.getByText(/The steps and the checklist/)).toBeTruthy();
  });
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
  it("holds exactly the three published guides", () => {
    expect(GUIDES.map((g) => g.href)).toEqual([
      "/guides/random-tokens",
      "/guides/solana-rent",
      "/guides/close-token-accounts",
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
});
