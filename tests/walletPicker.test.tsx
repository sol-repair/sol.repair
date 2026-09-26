// @vitest-environment jsdom

/**
 * Keyboard and focus tests for the wallet picker (audit F4).
 *
 * The picker is a modal dialog rendered by both read-only wallet
 * surfaces (the homepage connect button and the explainer's
 * recent-transactions walk). The contract under test:
 *   - focus enters the dialog when it opens,
 *   - Tab cycles inside it (forward from the last control, backward
 *     from the first, including the dialog container itself),
 *   - Escape closes it,
 *   - every close path returns focus to the triggering control,
 *   - picking a wallet still selects it and closes the dialog.
 *
 * Connection behavior itself is not under test here (the wallet
 * adapter is mocked); only that the picker calls select() with the
 * chosen wallet's name.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
}));

import { WalletButton } from "@/components/WalletButton";

const ICON = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

function twoWalletPickerContext(): Record<string, unknown> {
  return {
    wallet: null,
    wallets: [
      { adapter: { name: "Phantom", icon: ICON } },
      { adapter: { name: "Solflare", icon: ICON } },
    ],
    connect: vi.fn(),
    connected: false,
    connecting: false,
    disconnect: vi.fn(),
    select: vi.fn(),
    publicKey: null,
  };
}
beforeEach(() => {
  mocks.wallet = twoWalletPickerContext();
});

afterEach(cleanup);

function openPicker(): HTMLButtonElement {
  render(<WalletButton />);
  const trigger = screen.getByRole("button", { name: /select wallet/i });
  fireEvent.click(trigger);
  return trigger as HTMLButtonElement;
}

describe("wallet picker keyboard behavior", () => {
  it("moves focus into the dialog when it opens", () => {
    openPicker();
    const dialog = screen.getByRole("dialog", { name: /choose a wallet/i });
    expect(document.activeElement).toBe(dialog);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const trigger = openPicker();
    const dialog = screen.getByRole("dialog", { name: /choose a wallet/i });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: /choose a wallet/i })
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("wraps Tab from the last control back to the first", () => {
    openPicker();
    const dialog = screen.getByRole("dialog", { name: /choose a wallet/i });
    const cancel = screen.getByRole("button", { name: /cancel/i });
    cancel.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).not.toBe(cancel);
    // First focusable control inside the dialog is the first wallet row.
    expect(
      (document.activeElement as HTMLButtonElement).textContent
    ).toContain("Phantom");
  });

  it("wraps Shift+Tab from the first control back to the last", () => {
    openPicker();
    const dialog = screen.getByRole("dialog", { name: /choose a wallet/i });
    const cancel = screen.getByRole("button", { name: /cancel/i });
    const phantom = screen.getByRole("button", { name: /phantom/i });
    phantom.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });

  it("returns focus to the trigger when closed through Cancel", () => {
    const trigger = openPicker();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(
      screen.queryByRole("dialog", { name: /choose a wallet/i })
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("selects the chosen wallet, closes, and restores focus", () => {
    const trigger = openPicker();
    fireEvent.click(screen.getByRole("button", { name: /solflare/i }));
    expect(mocks.wallet.select).toHaveBeenCalledWith("Solflare");
    expect(
      screen.queryByRole("dialog", { name: /choose a wallet/i })
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("names the selected wallet on the connect control", () => {
    // Verification-pass finding: after picking a wallet, the connect
    // button looked identical no matter which wallet was picked. The
    // control must name (and show the icon of) the wallet it will ask.
    const { rerender } = render(<WalletButton />);
    fireEvent.click(screen.getByRole("button", { name: /select wallet/i }));
    fireEvent.click(screen.getByRole("button", { name: /phantom/i }));
    expect(mocks.wallet.select).toHaveBeenCalledWith("Phantom");
    // The adapter reacts to select() by exposing the chosen wallet.
    mocks.wallet.wallet = { adapter: { name: "Phantom", icon: ICON } };
    rerender(<WalletButton />);

    const connect = screen.getByRole("button", {
      name: /connect phantom to scan accounts/i,
    });
    const icon = connect.querySelector("img");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("alt")).toBe("");
  });

  it("shows the wallet icon on the connected control", () => {
    mocks.wallet = {
      wallet: { adapter: { name: "Phantom", icon: ICON } },
      wallets: [],
      connect: vi.fn(),
      connected: true,
      connecting: false,
      disconnect: vi.fn(),
      select: vi.fn(),
      publicKey: Keypair.generate().publicKey,
    };
    render(<WalletButton />);

    const connected = screen.getByRole("button", {
      name: /click to disconnect/i,
    });
    expect(connected.querySelector("img")).toBeTruthy();
  });
});
