// @vitest-environment jsdom

/**
 * In-flight repair progress tests (page.tsx).
 *
 * The first real mainnet repair (the owner, iPhone, Phantom) exposed a
 * dead window: after approving in the wallet, the page showed only
 * static text while the network confirmed, and a static line reads as
 * frozen ("is this stuck? is this a scam?"). The in-flight box must
 * show motion, a ticking elapsed-seconds counter, and the batch
 * position. Stage names come from the repair hook's real states; no
 * fake percentages and no countdowns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  Keypair,
  type Connection,
  type PublicKey,
} from "@solana/web3.js";
import type { ScanResult } from "@/lib/solana/tokenAccounts";

import Home from "../src/app/page";
import {
  AWAITING_HINT_DELAY_MS,
  AWAITING_SIGNATURE_HINT,
} from "../src/components/AwaitingSignatureHint";
import type { ReactNode } from "react";
import { renderHome } from "./renderHome";

const mocks = vi.hoisted(() => ({
  wallet: {
    publicKey: null as PublicKey | null,
    wallet: null,
    wallets: [] as unknown[],
    connect: vi.fn(),
    disconnect: vi.fn(),
    connecting: false,
    connected: true,
    select: vi.fn(),
  },
  scan: {
    loading: false,
    result: null as ScanResult | null,
    error: null as string | null,
    rescan: vi.fn(),
  },
  repair: {
    status: "idle" as string,
    signature: null as string | null,
    signatures: [] as string[],
    closedCount: 0,
    recoveredLamports: 0n,
    progress: null as { current: number; total: number } | null,
    error: null as string | null,
    errorDetail: null as string | null,
    repair: vi.fn(),
    reset: vi.fn(),
  },
  conn: {
    getAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    simulateTransaction: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
  useConnection: () => ({ connection: mocks.conn as unknown as Connection }),
  // The homepage mounts its Solana provider behind the lazy connect
  // boundary (and /report, /understand at their roots); these
  // passthroughs let the real provider component render with the
  // mocked wallet context underneath.
  ConnectionProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
  WalletProvider: ({ children }: { children?: ReactNode }) =>
    children as ReactNode,
}));

vi.mock("@/hooks/useWalletScan", () => ({
  useWalletScan: () => mocks.scan,
}));

vi.mock("@/hooks/useRepairWallet", async () => ({
  useRepairWallet: () => mocks.repair,
  // The page also imports the cap constant for its copy, so the fake must
  // carry it too. Read the REAL export rather than a copy of its value: a
  // hand-written 100 here would drift silently if the cap ever changed.
  MAX_ACCOUNTS_PER_RUN: (
    await vi.importActual<typeof import("@/hooks/useRepairWallet")>(
      "@/hooks/useRepairWallet"
    )
  ).MAX_ACCOUNTS_PER_RUN,
}));

// next/link needs the Next.js router context that plain jsdom does not
// provide. The footer links are not under test; render their children.
vi.mock("next/link", () => ({
  default: (props: { children?: unknown }) => props.children,
}));

const WALLET_KEYPAIR = Keypair.generate();

const SCAN_RESULT: ScanResult = {
  totalAccounts: 1,
  eligibleAccounts: [
    {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      lamports: 2039280,
      program: "spl",
    },
  ],
  recoverableLamports: 2039280n,
  skippedAccounts: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.conn.getAccountInfo.mockResolvedValue(null);
  mocks.wallet.publicKey = WALLET_KEYPAIR.publicKey;
  mocks.scan.loading = false;
  mocks.scan.result = SCAN_RESULT;
  mocks.scan.error = null;
  mocks.repair.status = "idle";
  mocks.repair.signature = null;
  mocks.repair.signatures = [];
  mocks.repair.progress = null;
  mocks.repair.error = null;
  mocks.repair.errorDetail = null;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("in-flight repair progress panel", () => {
  it("shows motion and a ticking counter while the transaction is in flight", async () => {
    mocks.repair.status = "sending";
    // First mount loads the lazy boundary under real timers (the
    // boundary await cannot run on fake timers). The resolved lazy
    // module then mounts synchronously, so the remount below runs with
    // fake timers and the ticker's interval is the fake one.
    await renderHome();
    cleanup();
    vi.useFakeTimers();
    render(<Home />);

    const box = screen.getByRole("status");
    expect(box.textContent).toContain("Approved. Sending to the network...");
    expect(box.querySelector("svg.animate-spin")).toBeTruthy();
    expect(screen.getByText("0s")).toBeTruthy();
    // The ticking number must stay out of the live region (audit F5):
    // aria-hidden keeps screen readers from re-announcing every tick.
    expect(screen.getByText("0s").getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("3s")).toBeTruthy();
    expect(screen.queryByText("0s")).toBeNull();
  });

  it("never renders a verifying card: the repair hook never sets that status", async () => {
    // The hook goes from "sending" straight to "checking" (a refused or
    // failed submission never proved "sent"), so a "verifying" card would
    // be dead display code claiming a state that cannot exist. Pin its
    // absence: even with the hook force-fed the dead status, no copy may
    // claim the network is confirming.
    mocks.repair.status = "verifying";
    await renderHome();

    expect(screen.queryByText(/Sent\. Waiting for the network/)).toBeNull();
    expect(
      screen.queryByText(/Waiting for the network to confirm/)
    ).toBeNull();
  });

  it("marks the sending stage as approved and in flight", async () => {
    mocks.repair.status = "sending";
    await renderHome();

    const box = screen.getByRole("status");
    expect(box.textContent).toContain("Approved. Sending to the network...");
    expect(box.querySelector("svg.animate-spin")).toBeTruthy();
    expect(screen.getByText("0s")).toBeTruthy();
  });

  it("shows the real batch position for multi-transaction repairs", async () => {
    mocks.repair.status = "sending";
    mocks.repair.progress = { current: 2, total: 5 };
    await renderHome();

    const box = screen.getByRole("status");
    expect(box.textContent).toContain("Transaction 2 of 5");
  });

  it("keeps the wallet prompt while waiting for the signature", async () => {
    mocks.repair.status = "awaiting-signature";
    await renderHome();

    const box = screen.getByRole("status");
    expect(box.textContent).toContain(
      "Check your wallet. Phantom is asking you to approve."
    );
    expect(box.querySelector("svg.animate-spin")).toBeTruthy();
  });

  it("keeps the owner's writing rules on the in-flight copy", async () => {
    const panels: string[] = [];
    for (const status of ["sending", "checking"] as const) {
      mocks.repair.status = status;
      const { unmount } = await renderHome();
      panels.push(screen.getByRole("status").textContent ?? "");
      unmount();
    }
    const text = panels.join(" ");
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});

describe("the awaiting-signature hint", () => {
  // The hint is the Sep 27 missed-popup fix: one honest sentence inside
  // the waiting card after a long silent wait, gone the moment the
  // state moves. The timer lives in the component; these tests pin the
  // behavior the user can observe, never the statuses.
  async function mountAwaiting() {
    mocks.repair.status = "awaiting-signature";
    // First mount resolves the lazy boundary under real timers; the
    // resolved module then mounts synchronously, so the remount below
    // runs entirely on fake timers (the ticking-counter pattern).
    await renderHome();
    cleanup();
    vi.useFakeTimers();
    return render(<Home />);
  }

  it("adds the hint inside the status card after 15 seconds of waiting", async () => {
    await mountAwaiting();
    expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS);
    });
    const card = screen.getByRole("status");
    expect(card.textContent).toContain(AWAITING_SIGNATURE_HINT);
    // The hint rides inside the live region card, beside the existing
    // prompt, so its appearance is announced politely with the card.
    expect(card.textContent).toContain(
      "Check your wallet. Phantom is asking you to approve."
    );
  });

  it("does not render the hint before 15 seconds", async () => {
    await mountAwaiting();
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS - 1);
    });
    expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeNull();
  });

  it("never renders the hint in the other in-flight states", async () => {
    for (const status of ["building", "sending", "checking"] as const) {
      mocks.repair.status = status;
      const { unmount } = await renderHome();
      vi.useFakeTimers();
      render(<Home />);
      await act(async () => {
        vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS * 2);
      });
      expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeNull();
      unmount();
      cleanup();
      vi.useRealTimers();
    }
  });

  it("removes the hint the moment the state moves on", async () => {
    const view = await mountAwaiting();
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS);
    });
    expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeTruthy();
    mocks.repair.status = "sending";
    await act(async () => {
      view.rerender(<Home />);
    });
    expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Approved. Sending to the network..."
    );
  });

  it("clears the hint timer on unmount", async () => {
    const view = await mountAwaiting();
    const withHint = vi.getTimerCount();
    expect(withHint).toBeGreaterThan(0);
    view.unmount();
    // Exactly one timer goes with the tree: the hint's. The page keeps
    // one unrelated timer of its own, so the pin is the removal, not an
    // empty world; the component's own cleanup is pinned to zero in the
    // section suites, which mount it in isolation.
    expect(vi.getTimerCount()).toBe(withHint - 1);
  });

  it("keeps the owner's writing rules on the hint", async () => {
    await mountAwaiting();
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS);
    });
    const text = screen.getByText(AWAITING_SIGNATURE_HINT).textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});
