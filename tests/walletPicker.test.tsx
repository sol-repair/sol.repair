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

import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
}));

import {
  BRAVE_IOS_CONNECT_MESSAGE,
  CONNECT_FAILED_MESSAGE,
  WalletButton,
} from "@/components/WalletButton";

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

describe("connect failure copy on Brave on iOS (row 17)", () => {
  // Brave on iOS cannot complete a wallet connect in the browser layer
  // (failure-mode matrix row 17), so the honest error names the way out
  // instead of suggesting a retry. The detection is a heuristic: only a
  // Brave marker AND an iOS user agent may switch the copy, and any
  // doubt keeps the existing generic message byte for byte.
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, "brave");
    Reflect.deleteProperty(window.navigator, "userAgent");
  });

  function setBraveIos(brave: boolean, ios: boolean) {
    if (ios) {
      Object.defineProperty(window.navigator, "userAgent", {
        value:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 " +
          "Mobile/15E148 Safari/604.1",
        configurable: true,
      });
    }
    if (brave) {
      Object.defineProperty(window.navigator, "brave", {
        value: { isBrave: async () => true },
        configurable: true,
      });
    }
  }

  async function connectFails() {
    mocks.wallet = {
      ...twoWalletPickerContext(),
      wallet: { adapter: { name: "Phantom", icon: ICON } },
      connect: vi.fn().mockRejectedValue(new Error("connect failed")),
    };
    render(<WalletButton />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /connect phantom to scan accounts/i,
      })
    );
    await act(async () => {});
  }

  it("keeps the existing generic message when the browser is not Brave on iOS", async () => {
    await connectFails();
    expect(screen.getByRole("alert").textContent).toBe(
      CONNECT_FAILED_MESSAGE
    );
  });

  it("shows the Brave-on-iOS message when Brave reports itself on an iOS user agent", async () => {
    setBraveIos(true, true);
    await connectFails();
    expect(screen.getByRole("alert").textContent).toBe(
      BRAVE_IOS_CONNECT_MESSAGE
    );
  });

  it("keeps the generic message for Brave outside iOS", async () => {
    setBraveIos(true, false);
    await connectFails();
    expect(screen.getByRole("alert").textContent).toBe(
      CONNECT_FAILED_MESSAGE
    );
  });

  it("keeps the generic message on iOS when the Brave marker is absent", async () => {
    setBraveIos(false, true);
    await connectFails();
    expect(screen.getByRole("alert").textContent).toBe(
      CONNECT_FAILED_MESSAGE
    );
  });

  it("keeps the owner's writing rules on the Brave copy", () => {
    const text = BRAVE_IOS_CONNECT_MESSAGE;
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});
