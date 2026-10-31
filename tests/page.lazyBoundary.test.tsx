// @vitest-environment jsdom

/**
 * Lazy wallet-boundary pins for the homepage (page.tsx).
 *
 * The wallet-adapter bundle (the chunk carrying the wallet-standard
 * protocol and the provider stack) used to ride the root layout onto
 * every route and the homepage's initial load. It now mounts behind a
 * next/dynamic boundary: the page renders the pre-connect shell and a
 * reserved placeholder where the connect button sits, and the wallet
 * app arrives in a deferred chunk without any user interaction.
 *
 * These pins hold the boundary contract:
 *  1. The real connect control is NOT mounted synchronously with the
 *     page; the placeholder is, and the pre-connect page is complete
 *     (headline, how-it-works strip, guides) so the shell alone is a
 *     usable page.
 *  2. Once the deferred chunk resolves, the real connect control
 *     appears and the pre-connect information is still there.
 *  3. Architecturally, the homepage shell must reach the wallet only
 *     through next/dynamic (no static wallet-adapter, hook, or lib
 *     import on the initial path), and the root layout must not mount
 *     the Solana provider at all (it would put the wallet chunk back
 *     onto every route).
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import Home from "../src/app/page";

afterEach(cleanup);

const repoRoot = join(__dirname, "..");

describe("homepage lazy wallet boundary", () => {
  it("renders the reserved placeholder, not the connect button, on first paint", () => {
    const { container } = render(<Home />);

    // The real connect control stays behind the deferred chunk: it is
    // not in the DOM during the placeholder beat.
    expect(
      screen.queryByRole("button", { name: /select wallet/i })
    ).toBeNull();

    // The placeholder reserves the button's space (the same gray box
    // the server render has always shown) inside the connect row.
    const placeholder = container.querySelector(
      ".mb-3.flex.items-stretch.gap-3 [aria-hidden='true'].bg-zinc-900"
    );
    expect(placeholder).toBeTruthy();

    // The shell alone is a complete, interactive pre-connect page:
    // the walkthrough, the cannot-do list, and the section anchors
    // all render without the wallet chunk.
    expect(
      screen.getByRole("heading", { name: /How it works/ })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /What SOL.repair cannot do/ })
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /How it works/ })
    ).toBeTruthy();
  });

  it(
    "mounts the real connect control when the deferred chunk arrives, with the pre-connect page intact",
    async () => {
      render(<Home />);

      const connect = await screen.findByRole(
        "button",
        { name: /select wallet/i },
        { timeout: 15000 }
      );
      expect(connect).toBeTruthy();

      // The pre-connect information survives the swap from placeholder
      // to real control: same page, same content, one deferred mount.
      expect(
        screen.getByRole("heading", { name: /How it works/ })
      ).toBeTruthy();
      expect(
        screen.getByText(
          /Connecting only lets the site read your wallet address, its token accounts, and the public mint accounts/
        )
      ).toBeTruthy();
    },
    // The real provider stack (web3.js and friends) imports cold in the
    // full suite; give the deferred chunk room to land.
    30000
  );
});

describe("wallet code stays off the initial path", () => {
  const src = (path: string) => readFileSync(join(repoRoot, "src", path), "utf8");

  it("reaches the wallet app only through next/dynamic", () => {
    const page = src("app/page.tsx");
    expect(page).toContain("next/dynamic");
    // The initial path statically imports neither the wallet-adapter
    // stack nor any hook or lib module that would pull it in.
    expect(page).not.toMatch(/@solana\/wallet-adapter/);
    expect(page).not.toMatch(/from "@\/hooks\//);
    expect(page).not.toMatch(/from "@\/lib\/solana\//);
    expect(page).not.toMatch(/from "@\/components\/(Wallet|SolanaProvider)/);
  });

  it("keeps the Solana provider out of the root layout", () => {
    // The layout wraps every route; a provider here would put the
    // wallet chunk back onto pages (the guides, changelog, legal
    // pages) that never touch a wallet.
    expect(src("app/layout.tsx")).not.toContain("SolanaProvider");
  });
});
