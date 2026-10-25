// @vitest-environment jsdom

/**
 * Component tests for BurnDustSection (dust spec Rev 1): the finding
 * rows, the per-item consent card with its permanent-destruction
 * warning, the fee line per the owner's Q1 ruling, the terminal
 * cards, and the cross-action affordance. The hook is mocked (its
 * behavior is pinned in tests/useBurnDust.test.tsx); the rendered copy
 * is what must be honest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

import { BurnDustSection } from "../src/components/BurnDustSection";
import {
  AWAITING_HINT_DELAY_MS,
  AWAITING_SIGNATURE_HINT,
} from "../src/components/AwaitingSignatureHint";
import type { BurnState } from "../src/hooks/useBurnDust";
import type { ScanResult, SkippedAccount } from "../src/lib/solana/tokenAccounts";

const mocks = vi.hoisted(() => ({
  holder: { publicKey: null as PublicKey | null },
  conn: { getParsedAccountInfo: vi.fn() },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.holder,
  useConnection: () => ({
    connection: mocks.conn as unknown as import("@solana/web3.js").Connection,
  }),
}));

vi.mock("@/hooks/useRpcConnection", () => ({
  useRpcConnection: () => mocks.conn,
}));

vi.mock("@/hooks/useBurnDust", () => ({
  useBurnDust: vi.fn(),
}));

import { useBurnDust } from "@/hooks/useBurnDust";

const hookMock = vi.mocked(useBurnDust);

const OWNER = Keypair.generate();
mocks.holder.publicKey = OWNER.publicKey;

const idleState = (): BurnState => ({
  status: "idle",
  outcome: null,
  signatures: [],
  accountPubkey: null,
  balanceAtScan: null,
  lamportsAtScan: null,
  balanceBeforeAction: null,
  lamportsBeforeAction: null,
  accountPresentAfterAction: null,
  delegatePresent: null,
  note: null,
  error: null,
  errorDetail: null,
});

const reset = vi.fn();

function setHook(over: Partial<BurnState>, actionInFlight = false) {
  hookMock.mockReturnValue({
    ...idleState(),
    ...over,
    actionInFlight,
    burn: vi.fn(),
    reset,
  });
}

function dustEntry(over: Partial<SkippedAccount> = {}): SkippedAccount {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    reason: "holds a token balance",
    program: "spl",
    cause: "funded",
    balance: "5000",
    decimals: 6,
    lamports: 2039280,
    nativeStatus: "non-native",
    ...over,
  };
}

function scanWith(entries: SkippedAccount[]): ScanResult {
  return {
    totalAccounts: entries.length,
    eligibleAccounts: [],
    recoverableLamports: 0n,
    skippedAccounts: entries,
  };
}

/** Render a section whose scan entry's mint is known, so the gate
 *  (presentation read) passes. Returns the entry. */
function renderWithEntry(feeReady: boolean, over: Partial<SkippedAccount> = {}) {
  const entry = dustEntry(over);
  mocks.conn.getParsedAccountInfo.mockResolvedValue({
    value: {
      owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      lamports: 2039280,
      data: {
        parsed: {
          info: {
            mint: entry.mint,
            owner: OWNER.publicKey.toBase58(),
            tokenAmount: {
              amount: entry.balance ?? "5000",
              decimals: entry.decimals ?? 6,
              uiAmount: 0.005,
              uiAmountString: "0.005",
            },
            state: "initialized",
            isNative: false,
          },
        },
      },
    },
  });
  render(
    <BurnDustSection
      scan={scanWith([entry])}
      rescan={() => {}}
      repairInFlight={false}
      revokeInFlight={false}
      unwrapInFlight={false}
      feeReady={feeReady}
    />
  );
  return { entry };
}

beforeEach(() => {
  vi.clearAllMocks();
  setHook({});
});

afterEach(cleanup);

describe("BurnDustSection finding rows", () => {
  it("renders the dust rows with balance, lamports, and the permanent warning", () => {
    render(
      <BurnDustSection
        scan={scanWith([dustEntry(), dustEntry({ frozen: true })])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
        unwrapInFlight={false}
        feeReady={false}
      />
    );
    expect(screen.getByText("Dust tokens")).toBeTruthy();
    expect(screen.getByText(/1 account holds tokens/i)).toBeTruthy();
    expect(screen.getAllByText(/Burn and close/)).toHaveLength(1);
    expect(screen.getAllByText(/5,000 base units/).length).toBeGreaterThan(0);
    expect(screen.getByText(/2,039,280 lamports total/)).toBeTruthy();
    expect(screen.getByText(/Burning a token destroys it permanently/i)).toBeTruthy();
    expect(
      screen.getByText(/cannot judge what a token is worth/i)
    ).toBeTruthy();
    // The frozen entry is not offered (it cannot be burned).
    expect(screen.queryByText(/frozen account cannot be burned/)).toBeNull();
  });

  it("hides itself entirely when the scan has no eligible dust", () => {
    const { container } = render(
      <BurnDustSection
        scan={scanWith([dustEntry({ frozen: true })])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
        unwrapInFlight={false}
        feeReady={false}
      />
    );
    expect(container.textContent).toBe("");
  });

  it("disables its buttons while another action is in flight", () => {
    render(
      <BurnDustSection
        scan={scanWith([dustEntry()])}
        rescan={() => {}}
        repairInFlight={true}
        revokeInFlight={false}
        unwrapInFlight={false}
        feeReady={false}
      />
    );
    const button = screen.getByRole("button", {
      name: "Burn and close",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText("Another wallet action is underway. Wait for it to finish.")
    ).toBeTruthy();
  });

  it("reports its own in-flight signal upward", () => {
    const onActionInFlightChange = vi.fn();
    setHook({}, true);
    render(
      <BurnDustSection
        scan={scanWith([dustEntry()])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
        unwrapInFlight={false}
        feeReady={false}
        onActionInFlightChange={onActionInFlightChange}
      />
    );
    expect(onActionInFlightChange).toHaveBeenLastCalledWith(true);
  });
});

describe("BurnDustSection consent card", () => {
  it("opens with the gate read and states the permanent burn with current figures", async () => {
    renderWithEntry(true);
    fireEvent.click(screen.getByRole("button", { name: "Burn and close" }));
    expect(await screen.findByText(/Review before you sign/)).toBeTruthy();
    expect(
      screen.getByText(/burns 5,000 base units of mint/i)
    ).toBeTruthy();
    expect(screen.getByText(/The burn is permanent\./)).toBeTruthy();
  });

  it("shows the 1% fee line when the fee account is ready and none when it is not", async () => {
    renderWithEntry(true);
    fireEvent.click(screen.getByRole("button", { name: "Burn and close" }));
    expect(await screen.findByText(/Service fee: ~0\.000020 SOL, 1% of the SOL this close returns\./)).toBeTruthy();
    cleanup();

    renderWithEntry(false);
    fireEvent.click(screen.getByRole("button", { name: "Burn and close" }));
    expect(
      await screen.findByText(
        /Service fee: none on this action \(the fee account is not ready yet\)\./
      )
    ).toBeTruthy();
  });

  it("keeps the owner's writing rules on the card copy", async () => {
    renderWithEntry(true);
    fireEvent.click(screen.getByRole("button", { name: "Burn and close" }));
    await screen.findByText(/Review before you sign/);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/[\u2014\u2013]/);
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(text).not.toMatch(/!/);
  });

  it("shows the gate abort with its honest sentence and a rescan path", async () => {
    renderWithEntry(true);
    // The presentation read reports frozen.
    mocks.conn.getParsedAccountInfo.mockResolvedValue({
      value: {
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        lamports: 2039280,
        data: {
          parsed: {
            info: {
              mint: Keypair.generate().publicKey.toBase58(),
              owner: OWNER.publicKey.toBase58(),
              tokenAmount: {
                amount: "5000",
                decimals: 6,
                uiAmount: 0.005,
                uiAmountString: "0.005",
              },
              state: "frozen",
              isNative: false,
            },
          },
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Burn and close" }));
    expect(
      await screen.findByText(
        /a frozen account cannot be burned\. Nothing was signed\./i
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rescan" })).toBeTruthy();
  });
});

describe("BurnDustSection terminal cards", () => {
  it("renders the verified burn with the destroyed-balance story", () => {
    setHook({
      status: "done",
      outcome: "burn-verified",
      accountPubkey: dustEntry().pubkey,
      balanceBeforeAction: "5000",
      accountPresentAfterAction: false,
      signatures: ["SIG1111111111111111111111111111111111111111"],
    });
    const { container } = render(
      <BurnDustSection
        scan={scanWith([dustEntry()])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
        unwrapInFlight={false}
        feeReady={false}
      />
    );
    expect(screen.getByText("Burn and close complete.")).toBeTruthy();
    expect(container.textContent).toContain(
      "no longer exists, confirmed by a fresh read after the transaction"
    );
    expect(container.textContent).toContain(
      "5,000 base units, read just before the burn, was destroyed permanently"
    );
  });

  it("renders the on-chain failure with the observation note", () => {
    setHook({
      status: "error",
      outcome: "on-chain-failure",
      accountPresentAfterAction: true,
      error: "The transaction was confirmed on-chain but failed. It changed nothing.",
    });
    render(
      <BurnDustSection
        scan={scanWith([dustEntry()])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
        unwrapInFlight={false}
        feeReady={false}
      />
    );
    expect(screen.getByText("The burn did not go through")).toBeTruthy();
    expect(
      screen.getByText(/When we checked, the account still existed\./i)
    ).toBeTruthy();
  });

  it("renders the unverified card as its own amber terminal", () => {
    setHook({
      status: "unverified",
      outcome: "unresolved-outcome",
      error:
        "We could not verify whether the burn landed. The transaction's outcome could not be established. It may still land. Nothing more will be sent automatically.",
    });
    render(
      <BurnDustSection
        scan={scanWith([dustEntry()])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
        unwrapInFlight={false}
        feeReady={false}
      />
    );
    expect(
      screen.getAllByText(/We could not verify whether the burn landed/i)
        .length
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /Rescan to check the current state/i })
    ).toBeTruthy();
  });
});

describe("the awaiting-signature hint (burn card)", () => {
  // The Sep 27 missed-popup finding, on this card: one honest sentence
  // inside the waiting card after a long silent wait, gone the moment
  // the state moves. Component-level only; the hook is untouched.
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderBurn() {
    setHook({ status: "awaiting-signature" }, true);
    return render(
      <BurnDustSection
        scan={scanWith([dustEntry()])}
        rescan={() => {}}
        repairInFlight={false}
        revokeInFlight={false}
        unwrapInFlight={false}
        feeReady={false}
      />
    );
  }

  it("adds the hint inside the status card after 15 seconds of waiting", async () => {
    vi.useFakeTimers();
    renderBurn();
    expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS);
    });
    const card = screen.getByRole("status");
    expect(card.textContent).toContain(AWAITING_SIGNATURE_HINT);
    expect(card.textContent).toContain(
      "Check your wallet. Approve to burn and close."
    );
  });

  it("never renders the hint in the other in-flight states", async () => {
    vi.useFakeTimers();
    for (const status of [
      "checking-current-state",
      "building",
      "sending",
      "confirming",
      "verifying",
    ] as const) {
      setHook({ status }, true);
      cleanup();
      render(
        <BurnDustSection
          scan={scanWith([dustEntry()])}
          rescan={() => {}}
          repairInFlight={false}
          revokeInFlight={false}
          unwrapInFlight={false}
          feeReady={false}
        />
      );
      await act(async () => {
        vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS * 2);
      });
      expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeNull();
    }
  });

  it("removes the hint the moment the state moves on", async () => {
    vi.useFakeTimers();
    const view = renderBurn();
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS);
    });
    expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeTruthy();
    setHook({ status: "sending" }, true);
    await act(async () => {
      view.rerender(
        <BurnDustSection
          scan={scanWith([dustEntry()])}
          rescan={() => {}}
          repairInFlight={false}
          revokeInFlight={false}
          unwrapInFlight={false}
          feeReady={false}
        />
      );
    });
    expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeNull();
  });

  it("clears the hint timer on unmount", async () => {
    vi.useFakeTimers();
    const view = renderBurn();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the owner's writing rules on the hint", async () => {
    vi.useFakeTimers();
    renderBurn();
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS);
    });
    const text = screen.getByText(AWAITING_SIGNATURE_HINT).textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});
