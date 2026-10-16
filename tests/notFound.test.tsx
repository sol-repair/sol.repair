// @vitest-environment jsdom

/**
 * Render tests for the root not-found page (P1 from the 2026-10-16
 * production pass). Without this file the framework default renders a
 * bare "404" with no navigation, a dead end on a phone. The page must
 * keep the honest sentence, state that nothing touched the wallet, and
 * above all carry a way back into the site.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import NotFound from "@/app/not-found";

afterEach(cleanup);

describe("root not-found page", () => {
  it("keeps the honest not-found sentence", () => {
    render(<NotFound />);
    expect(screen.getByText("404")).toBeTruthy();
    expect(
      screen.getByText(/This page could not be found/i)
    ).toBeTruthy();
  });

  it("states that nothing was requested from the wallet", () => {
    render(<NotFound />);
    expect(
      screen.getByText(/Nothing was requested from your wallet/i)
    ).toBeTruthy();
  });

  it("offers exactly one way home: a bordered link to the repair tool", () => {
    render(<NotFound />);
    const home = screen.getByRole("link", {
      name: /Back to the repair tool/i,
    });
    expect(home.getAttribute("href")).toBe("/");
    // Bordered, never green: navigation must not look like a signing
    // control (button doctrine in globals.css).
    expect(home.className).toContain("border");
    expect(home.className).not.toContain("14F195");
    // It is the only link on the page: the way home, not a menu.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
