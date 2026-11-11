// @vitest-environment jsdom

/**
 * Component tests for ExcessSection's awaiting-signature card: the
 * Sep 27 missed-popup hint, one honest sentence inside the waiting
 * card after a long silent wait, gone the moment the state moves.
 *
 * The hook is mocked (its behavior is pinned in
 * tests/useWithdrawExcess.test.tsx); detection is mocked to one
 * candidate so the section renders; the rendered copy is what must be
 * honest. The section's other cards are pinned in the useWithdrawExcess
 * suite and the page wiring in tests/page.excess.test.tsx.
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

import { ExcessSection } from "../src/components/ExcessSection";
import {
  AWAITING_HINT_DELAY_MS,
  AWAITING_SIGNATURE_HINT,
} from "../src/components/AwaitingSignatureHint";
import type { ExcessState } from "../src/hooks/useWithdrawExcess";
import type { ScanResult } from "@/lib/solana/tokenAccounts";
import type { ExcessCandidate } from "@/lib/solana/excessLamports";

const mocks = vi.hoisted(() => ({
  holder: { publicKey: null as PublicKey | null },
  // Stable reference: ExcessSection's detection effect depends on the
  // connection, so a fresh object per render would loop forever.
  conn: {
    getMultipleAccountsInfo: vi.fn(),
    getMinimumBalanceForRentExemption: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.holder,
}));

vi.mock("@/hooks/useRpcConnection", () => ({
  useRpcConnection: () => mocks.conn,
}));

vi.mock("@/hooks/useWithdrawExcess", () => ({
  useWithdrawExcess: vi.fn(),
}));

vi.mock("@/lib/solana/excessLamports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/solana/excessLamports")>();
  return { ...actual, detectExcessCandidates: vi.fn() };
});

import { useWithdrawExcess } from "@/hooks/useWithdrawExcess";
import { detectExcessCandidates } from "@/lib/solana/excessLamports";

const hookMock = vi.mocked(useWithdrawExcess);
const detectMock = vi.mocked(detectExcessCandidates);

const OWNER = Keypair.generate();
mocks.holder.publicKey = OWNER.publicKey;

const idleState = (): ExcessState => ({
  status: "idle",
  outcome: null,
  signatures: [],
  accountPubkey: null,
  excessAtDetection: null,
  lamportsAtDetection: null,
  excessBeforeAction: null,
  lamportsBeforeAction: null,
  lamportsAfterAction: null,
  note: null,
  error: null,
  errorDetail: null,
});

const withdraw = vi.fn();
const reset = vi.fn();

function setHook(over: Partial<ExcessState>, actionInFlight = false) {
  hookMock.mockReturnValue({
    ...idleState(),
    ...over,
    actionInFlight,
    withdraw,
    reset,
  });
}

const CANDIDATE: ExcessCandidate = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  lamports: 2738880,
  dataLen: 170,
  excess: 250000,
  frozen: false,
};

function scanWithCandidate(): ScanResult {
  return {
    totalAccounts: 1,
    eligibleAccounts: [],
    recoverableLamports: 0n,
    skippedAccounts: [],
  };
}

async function renderSection() {
  const view = render(
    <ExcessSection
      scan={scanWithCandidate()}
      rescan={() => {}}
      repairInFlight={false}
      revokeInFlight={false}
      unwrapInFlight={false}
      burnInFlight={false}
    />
  );
  // Detection resolves on mount; flush it so the section body appears.
  await act(async () => {});
  return view;
}

beforeEach(() => {
  detectMock.mockResolvedValue([CANDIDATE]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the awaiting-signature hint (excess card)", () => {
  it("adds the hint inside the status card after 15 seconds of waiting", async () => {
    setHook({ status: "awaiting-signature" }, true);
    vi.useFakeTimers();
    await renderSection();
    expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS);
    });
    const card = screen.getByRole("status");
    expect(card.textContent).toContain(AWAITING_SIGNATURE_HINT);
    expect(card.textContent).toContain(
      "Check your wallet. Approve to withdraw the excess."
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
      await renderSection();
      await act(async () => {
        vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS * 2);
      });
      expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeNull();
    }
  });

  it("removes the hint the moment the state moves on", async () => {
    setHook({ status: "awaiting-signature" }, true);
    vi.useFakeTimers();
    const view = await renderSection();
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS);
    });
    expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeTruthy();
    setHook({ status: "sending" }, true);
    await act(async () => {
      view.rerender(
        <ExcessSection
          scan={scanWithCandidate()}
          rescan={() => {}}
          repairInFlight={false}
          revokeInFlight={false}
          unwrapInFlight={false}
          burnInFlight={false}
        />
      );
    });
    expect(screen.queryByText(AWAITING_SIGNATURE_HINT)).toBeNull();
  });

  it("clears the hint timer on unmount", async () => {
    setHook({ status: "awaiting-signature" }, true);
    vi.useFakeTimers();
    const view = await renderSection();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the project writing rules on the hint", async () => {
    setHook({ status: "awaiting-signature" }, true);
    vi.useFakeTimers();
    await renderSection();
    await act(async () => {
      vi.advanceTimersByTime(AWAITING_HINT_DELAY_MS);
    });
    const text = screen.getByText(AWAITING_SIGNATURE_HINT).textContent ?? "";
    expect(text.includes("\u2014") || text.includes("\u2013")).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    expect(text.includes("!")).toBe(false);
  });
});

describe("ExcessSection reviewed figures and the preview race", () => {
  const T22_PROGRAM = new PublicKey(
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
  );

  /** A raw account read the real readExcessState accepts: the
   *  Token-2022 program owns it, the connected wallet owns the base
   *  data, and the lamports are as named. */
  function rawAccount(lamports: number) {
    const data = new Uint8Array(165);
    data.set(OWNER.publicKey.toBytes(), 32);
    return {
      lamports,
      owner: T22_PROGRAM,
      data,
      executable: false,
      rentEpoch: null,
    };
  }

  function configureGateRead(lamports: number, reserve: number) {
    mocks.conn.getMultipleAccountsInfo.mockReset();
    mocks.conn.getMinimumBalanceForRentExemption.mockReset();
    mocks.conn.getMultipleAccountsInfo.mockResolvedValue([rawAccount(lamports)]);
    mocks.conn.getMinimumBalanceForRentExemption.mockResolvedValue(reserve);
  }

  function excessCandidate(over: Partial<ExcessCandidate> = {}): ExcessCandidate {
    return {
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
      lamports: 2738880,
      dataLen: 165,
      excess: 250000,
      frozen: false,
      ...over,
    };
  }

  it("passes the reviewed figures into the hook on approve", async () => {
    // CANDIDATE: lamports 2738880, excess 250000. The gate read
    // reproduces exactly those figures.
    configureGateRead(2738880, 2738880 - 250000);
    const withdrawFn = vi.fn();
    hookMock.mockReturnValue({
      ...idleState(),
      actionInFlight: false,
      withdraw: withdrawFn,
      reset,
    });
    await renderSection();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Withdraw excess" })[0]
    );
    await screen.findByText(/Review before you sign/);
    await screen.findByText(/Spare lamports at the fresh read just now/);
    const buttons = screen.getAllByRole("button", {
      name: "Withdraw excess",
    });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(withdrawFn).toHaveBeenCalledWith(CANDIDATE, {
      excess: 250000,
      lamports: 2738880,
    });
  });

  it("ignores a stale preview reply from a previously reviewed candidate", async () => {
    const entryA = excessCandidate({ excess: 250000, lamports: 2738880 });
    const entryB = excessCandidate({
      excess: 350000,
      lamports: 3738880,
    });
    detectMock.mockResolvedValue([entryA, entryB]);
    let resolveA: (v: unknown) => void = () => {};
    let resolveB: (v: unknown) => void = () => {};
    mocks.conn.getMultipleAccountsInfo.mockReset();
    mocks.conn.getMinimumBalanceForRentExemption.mockReset();
    // Per read: A's reserve yields its 250000 excess, B's its 350000.
    mocks.conn.getMinimumBalanceForRentExemption
      .mockResolvedValueOnce(2738880 - 250000)
      .mockResolvedValue(3738880 - 350000);
    mocks.conn.getMultipleAccountsInfo
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveA = res as (v: unknown) => void;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveB = res as (v: unknown) => void;
          })
      );
    await renderSection();
    const buttons = screen.getAllByRole("button", {
      name: "Withdraw excess",
    });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(await screen.findByText(/Review before you sign/)).toBeTruthy();
    // A's slow reply lands after B's selection: ignored, the card
    // stays in its reading state.
    await act(async () => {
      resolveA([rawAccount(2738880)]);
    });
    expect(
      screen.queryByText(/Spare lamports at the fresh read just now: 250,000/)
    ).toBeNull();
    // B's own reply populates the card with B's figures.
    await act(async () => {
      resolveB([rawAccount(3738880)]);
    });
    expect(
      await screen.findByText(
        /Spare lamports at the fresh read just now: 350,000/
      )
    ).toBeTruthy();
    expect(
      screen.queryByText(/Spare lamports at the fresh read just now: 250,000/)
    ).toBeNull();
  });
});
