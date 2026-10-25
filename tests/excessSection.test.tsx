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
  conn: {},
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

  it("keeps the owner's writing rules on the hint", async () => {
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
