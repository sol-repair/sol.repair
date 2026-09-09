// @vitest-environment jsdom

/**
 * The route error boundary (src/app/error.tsx) is the site's last line
 * of defense against a render-time crash: without it, any exception in
 * any page component white-screens the route with no recovery path and
 * no honest explanation. These tests pin the three things the boundary
 * owes the user: the honest copy (the error cannot sign or send), a
 * working recovery action, and the console record for diagnosis.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import ErrorBoundary from "../src/app/error";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the route error boundary", () => {
  it("shows an honest fallback that names the failure as page-side", () => {
    render(
      <ErrorBoundary error={new Error("boom")} retry={() => {}} />
    );
    expect(
      screen.getByText(/this page hit an unexpected error/i)
    ).toBeTruthy();
    // The one reassurance that matters for a wallet tool: the crash
    // itself cannot sign or send anything.
    expect(screen.getByText(/nothing was signed or sent/i)).toBeTruthy();
    // Mid-repair crashes are the confusing case; the copy has to point
    // at the rescan, the only truthful recovery.
    expect(screen.getByText(/scan your wallet again/i)).toBeTruthy();
  });

  it("retries the route when the recovery button is clicked", () => {
    const retry = vi.fn();
    render(<ErrorBoundary error={new Error("boom")} retry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("records the error to the console for diagnosis", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    render(
      <ErrorBoundary error={new Error("the real cause")} retry={() => {}} />
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "the real cause" })
    );
  });
});
