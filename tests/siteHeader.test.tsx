// @vitest-environment jsdom

/**
 * Site header regression pins (direction A chrome).
 *
 * The header once crushed the network badge at phone width: no wrap on
 * the row, a shrink-0 wordmark, and nowrap nav links left the badge to
 * shrink into a multiline pill (observed at 390px with the devnet
 * badge's longer text). jsdom cannot measure real layout, so these pins
 * hold the exact classes that implement the fix: the row and its right
 * group must wrap, the badge must never wrap internally, and nothing in
 * the row may opt into shrinking below its content width.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SiteHeader } from "@/components/SiteHeader";

afterEach(cleanup);

describe("site header", () => {
  it("links the wordmark home and offers exactly the three read-only destinations", () => {
    render(<SiteHeader />);
    expect(
      screen.getByRole("link", { name: "SOL.repair" }).getAttribute("href")
    ).toBe("/");
    const nav = within(screen.getByRole("navigation", { name: "Site" }));
    const hrefs = nav
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"))
      .sort();
    expect(hrefs).toEqual(["/fees", "/guides", "/understand"]);
  });

  it("marks the active section for assistive technology", () => {
    render(<SiteHeader active="guides" />);
    const nav = within(screen.getByRole("navigation", { name: "Site" }));
    expect(nav.getByRole("link", { name: "Guides" }).getAttribute("aria-current")).toBe(
      "page"
    );
    expect(
      nav.getByRole("link", { name: "Understand" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("wraps instead of crushing: the row and its right group carry flex-wrap, and nothing shrinks below content", () => {
    const { container } = render(<SiteHeader active="fees" />);
    const row = container.firstElementChild as HTMLElement;
    // The wrap behavior itself: both flex levels may break onto new
    // lines, so a narrow phone drops the badge group whole instead of
    // compressing it.
    expect(row.className).toContain("flex-wrap");
    const group = row.lastElementChild as HTMLElement;
    expect(group.className).toContain("flex-wrap");
    // The old bug's enabler: min-w-0 let the badge shrink below its
    // content width. It must stay gone from both flex levels.
    expect(row.className).not.toContain("min-w-0");
    expect(group.className).not.toContain("min-w-0");
  });

  it("keeps the network badge on one line", () => {
    const { container } = render(<SiteHeader />);
    // In the test environment the app is on devnet, so the badge carries
    // the longer test-funds text: exactly the shape that crushed.
    const badge = within(container as HTMLElement)
      .getByText(/test funds only/)
      .closest("span");
    expect(badge).toBeTruthy();
    expect(badge?.className).toContain("whitespace-nowrap");
  });
});
