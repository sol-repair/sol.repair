// @vitest-environment jsdom

/**
 * The pre-connect Example scan block mirrors the redesigned scan rows
 * (the owner-approved demo design): labeled Account and Mint lines,
 * the program chips, and the recoverable amount emphasized per card.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { PreConnectInfo } from "@/components/PreConnectInfo";

afterEach(cleanup);

describe("the pre-connect example scan", () => {
  it("renders the example as labeled cards with the recoverable amounts", () => {
    render(<PreConnectInfo />);
    expect(screen.getAllByText("Account").length).toBe(3);
    expect(screen.getAllByText("Mint").length).toBe(3);
    expect(screen.getAllByText(/recovers 0\.002039 SOL/).length).toBe(1);
    expect(screen.getAllByText(/recovers 0\.002074 SOL/).length).toBe(1);
    expect(screen.getAllByText(/recovers 0\.001488 SOL/).length).toBe(1);
    expect(screen.getAllByText("Token-2022").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("revoke + close").length).toBe(1);
  });

  it("keeps the owner writing rules on the example block", () => {
    const { container } = render(<PreConnectInfo />);
    const text = container.textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(text.includes("!")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
  });
});
