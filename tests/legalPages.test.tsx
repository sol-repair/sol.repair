// @vitest-environment jsdom

/**
 * Render pins for the legal pages.
 *
 * The terms page states the fee numbers the product actually charges and
 * the privacy page states the data claims the site is built on; both are
 * load-bearing trust copy, so they get the same treatment as the home
 * page: the claims are pinned, and the owner's writing rules (no emdashes,
 * no emojis, no exclamation marks) hold mechanically. A test fails if any
 * of that drifts.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";

afterEach(cleanup);

const PAGES = [
  { name: "terms", Component: TermsPage },
  { name: "privacy", Component: PrivacyPage },
];

describe("terms page pins the fee and service claims", () => {
  it("states the 1% success fee and the nothing-recovered-no-fee rule", () => {
    render(<TermsPage />);
    expect(
      screen.getByText(/1% of the SOL that a successful repair returns/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/if your repair recovers nothing, you owe no/i)
    ).toBeTruthy();
  });

  it("states the network base fee and the observed priority fee range", () => {
    render(<TermsPage />);
    expect(
      screen.getByText(/base fee of about 0\.000005 SOL per transaction/i)
    ).toBeTruthy();
    expect(
      screen.getByText(
        /recently run between about 0\.000075 and 0\.00015 SOL per transaction/i
      )
    ).toBeTruthy();
  });

  it("publishes that the fee address lives in the open-source repository", () => {
    render(<TermsPage />);
    expect(
      screen.getByText(/fee address is published in the open-source repository/i)
    ).toBeTruthy();
  });

  it("states the service is not a custodian or financial service", () => {
    render(<TermsPage />);
    expect(
      screen.getByText(/not a wallet, exchange, custodian, or financial service/i)
    ).toBeTruthy();
  });
});

describe("privacy page pins the data claims", () => {
  it("never asks for private keys or seed phrases", () => {
    render(<PrivacyPage />);
    expect(
      screen.getByText(/private keys or seed phrase, ever/i)
    ).toBeTruthy();
  });

  it("keeps scanning and transaction building in the browser", () => {
    render(<PrivacyPage />);
    expect(
      screen.getByText(/All scanning and transaction-building happens in your browser/i)
    ).toBeTruthy();
  });

  it("sets no advertising or tracking cookies", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/no advertising or tracking cookies/i)).toBeTruthy();
  });

  it("does not sell data and names the third parties it relies on", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/We do not sell, rent, or share data/i)).toBeTruthy();
    expect(screen.getByText(/Vercel, which hosts this website/i)).toBeTruthy();
  });
});

describe("legal pages keep the owner's writing rules", () => {
  it("renders without emdashes, emojis, or exclamation marks", () => {
    for (const { name, Component } of PAGES) {
      const { container } = render(<Component />);
      const text = container.textContent ?? "";
      expect(text, `${name}: no emdash`).not.toMatch(/[\u2014\u2013]/);
      expect(text, `${name}: no emoji`).not.toMatch(
        /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
      );
      expect(text, `${name}: no exclamation marks`).not.toMatch(/!/);
    }
  });
});
