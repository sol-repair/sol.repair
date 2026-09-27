// @vitest-environment jsdom

/**
 * Hook tests for useWithdrawExcess (G.4, Revision 1). The lib's wire
 * format and gate rules are pinned in excessLamports.test.ts; here the
 * lifecycle: mutex, in-lock gate, the single hand-built instruction
 * (no fee, no close), the lamports-based verification, and the §8.11
 * unresolved hold.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { acquireAction, heldAction, releaseAction } from "../src/lib/actionMutex";
import {
  useWithdrawExcess,
  type ExcessState,
} from "../src/hooks/useWithdrawExcess";

const mocks = vi.hoisted(() => ({
  wallet: {
    publicKey: null as PublicKey | null,
    signTransaction: null as ((tx: unknown) => Promise<unknown>) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
  conn: {
    getMultipleAccountsInfo: vi.fn(),
    getMinimumBalanceForRentExemption: vi.fn(),
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    getSignatureStatuses: vi.fn(),
    getBlockHeight: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.wallet,
  useConnection: () => ({ connection: mocks.conn as unknown }),
}));

vi.mock("@/hooks/useRpcConnection", () => ({
  useRpcConnection: () => mocks.conn,
}));

const OWNER = Keypair.generate();
const SWITCHED = Keypair.generate();
const ACCOUNT = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey.toBase58();

const CANDIDATE = {
  pubkey: ACCOUNT.toBase58(),
  mint: MINT,
  lamports: 2000000,
  dataLen: 165,
  excess: 511560,
  frozen: false,
};

const RESERVE = 1488440;

function accountRaw(lamports: number, dataLen = 165) {
  return {
    lamports,
    owner: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    data: new Uint8Array(dataLen),
    executable: false,
    rentEpoch: null,
  };
}

function gateRaw() {
  return [accountRaw(2000000)];
}

function fakeSigned() {
  const signature = bs58.encode(new Uint8Array(64).fill(9));
  return {
    signatures: [{ signature: bs58.decode(signature) }],
    serialize: () => new Uint8Array([1, 2, 3]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (heldAction()) releaseAction(heldAction()!);
  mocks.wallet.publicKey = OWNER.publicKey;
  mocks.wallet.signTransaction = vi.fn(async () => fakeSigned());
  mocks.conn.getLatestBlockhash.mockResolvedValue({
    blockhash: "BLOCKHASH",
    lastValidBlockHeight: 1000,
    feeCalculator: {},
  });
  mocks.conn.sendRawTransaction.mockResolvedValue("SIG");
  mocks.conn.getBlockHeight.mockResolvedValue(999);
  mocks.conn.getMinimumBalanceForRentExemption.mockResolvedValue(RESERVE);
});

afterEach(cleanup);

function confirmedStatus() {
  return { value: [{ err: null, confirmationStatus: "finalized" }] };
}

describe("useWithdrawExcess lifecycle", () => {
  it("reports action-conflict when another action holds the mutex", async () => {
    expect(acquireAction("repair")).toBe(true);
    const { result } = renderHook(() => useWithdrawExcess());
    await act(async () => {
      await result.current.withdraw(CANDIDATE);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.outcome).toBe("action-conflict");
    releaseAction("repair");
  });

  it("aborts in-lock when the fresh read fails (nothing signed)", async () => {
    mocks.conn.getMultipleAccountsInfo.mockRejectedValue(new Error("rpc down"));
    const { result } = renderHook(() => useWithdrawExcess());
    await act(async () => {
      await result.current.withdraw(CANDIDATE);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.outcome).toBe("gate-state-changed");
    expect(result.current.error).toContain("Nothing was signed");
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
    expect(heldAction()).toBeNull();
  });

  it("verifies a clean withdrawal end to end: one instruction, account remains at its reserve", async () => {
    // Gate read (call 1) shows the excess; verification reads (2..)
    // show the account at exactly its reserve.
    let calls = 0;
    mocks.conn.getMultipleAccountsInfo.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? gateRaw() : [accountRaw(RESERVE)];
    });
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    const signedTxs: Array<{ instructions: unknown[] }> = [];
    mocks.wallet.signTransaction = vi.fn(async (tx: unknown) => {
      signedTxs.push(tx as { instructions: unknown[] });
      return fakeSigned();
    });
    const { result } = renderHook(() => useWithdrawExcess());
    await act(async () => {
      await result.current.withdraw(CANDIDATE);
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.outcome).toBe("withdraw-verified");
    expect(result.current.lamportsAfterAction).toBe(RESERVE);
    // Exactly ONE instruction: the hand-built tag-38 withdrawal. No
    // fee, no close.
    expect(signedTxs[0].instructions).toHaveLength(1);
    expect(heldAction()).toBeNull();
  });

  it("reports an on-chain failure when the excess is unchanged after confirmation", async () => {
    let calls = 0;
    mocks.conn.getMultipleAccountsInfo.mockImplementation(async () => {
      calls += 1;
      // Every read shows the same excess: the confirmed transaction
      // changed nothing.
      return gateRaw();
    });
    void calls;
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    const { result } = renderHook(() => useWithdrawExcess());
    await act(async () => {
      await result.current.withdraw(CANDIDATE);
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.outcome).toBe("on-chain-failure");
  });

  it("reports already-withdrawn when the gate finds no excess", async () => {
    mocks.conn.getMultipleAccountsInfo.mockResolvedValue([
      accountRaw(RESERVE),
    ]);
    const { result } = renderHook(() => useWithdrawExcess());
    await act(async () => {
      await result.current.withdraw(CANDIDATE);
    });
    expect(result.current.status).toBe("done");
    expect(result.current.outcome).toBe("already-withdrawn");
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("reports unverified via the unresolved terminal and holds the lock until the dismissal", async () => {
    // Gate passes, then every status query fails with the block height
    // past the window: the §8.5 unresolved shape.
    let gateDone = false;
    mocks.conn.getMultipleAccountsInfo.mockImplementation(async () => {
      if (!gateDone) {
        gateDone = true;
        return gateRaw();
      }
      return gateRaw();
    });
    mocks.conn.getSignatureStatuses.mockRejectedValue(new Error("rpc down"));
    mocks.conn.getBlockHeight.mockResolvedValue(5000);
    const { result } = renderHook(() => useWithdrawExcess());
    await act(async () => {
      await result.current.withdraw(CANDIDATE);
    });
    await waitFor(() => expect(result.current.status).toBe("unverified"), {
      timeout: 30000,
    });
    expect(result.current.outcome).toBe("unresolved-outcome");
    expect(result.current.actionInFlight).toBe(true);
    expect(heldAction()).toBe("excess");
    await act(async () => {
      result.current.reset();
    });
    expect(heldAction()).toBeNull();
  }, 40000);
});

/**
 * The §8.5 transition matrix, backfilled to match the useUnwrapNative /
 * useRevokeDelegate suites, which pin the same shared lifecycle for the
 * older flows. Only the RPC boundary and the wallet adapter are mocked;
 * the hook under test is the real one. Fake timers drive the poll and
 * corroboration-space intervals, so every branch runs instantly: the
 * unanimous corroboration re-sign, the asymmetric drift block, the
 * late-status win, the mid-corroboration on-chain error, the bounded
 * second-expiry terminals, the one-refusal retry budget, the mid-flight
 * wallet switch, the processed-status totality rule, and the lock's
 * release points at each terminal.
 */
describe("the §8.5 evidence standard, sign-stage budget, and remaining terminals (fake timers)", () => {
  const WINDOW = 1000;
  const UNOBSERVED = { value: [null] };

  beforeEach(() => {
    vi.useFakeTimers();
    // Wipe unconsumed Once-queues from earlier tests: a leftover queued
    // answer would silently shift every later read/status sequence.
    mocks.conn.getMultipleAccountsInfo.mockReset();
    mocks.conn.getMinimumBalanceForRentExemption.mockReset();
    mocks.conn.getLatestBlockhash.mockReset();
    mocks.conn.sendRawTransaction.mockReset();
    mocks.conn.getSignatureStatuses.mockReset();
    mocks.conn.getBlockHeight.mockReset();
    mocks.conn.getMinimumBalanceForRentExemption.mockResolvedValue(RESERVE);
    mocks.conn.getLatestBlockhash.mockResolvedValue({
      blockhash: "BLOCKHASH",
      lastValidBlockHeight: WINDOW,
      feeCalculator: {},
    });
    mocks.conn.sendRawTransaction.mockResolvedValue("SIG");
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW - 10);
  });

  afterEach(() => {
    // The module-scoped mutex outlives a test; never leak a hold into
    // the next test (the unresolved terminal intentionally keeps it).
    releaseAction("excess");
    vi.useRealTimers();
  });

  function renderExcess() {
    return renderHook(() => useWithdrawExcess());
  }

  async function flushUntil(
    result: { current: ExcessState | undefined },
    until: (status: ExcessState["status"]) => boolean,
    maxMs = 240_000
  ) {
    for (let elapsed = 0; elapsed <= maxMs; elapsed += 250) {
      const current = result.current;
      if (current && until(current.status)) return;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
    }
    throw new Error(
      `flow did not reach its terminal state; status=${result.current?.status}`
    );
  }

  it("re-signs once when every corroboration read is unanimous", async () => {
    mocks.conn.getSignatureStatuses
      .mockResolvedValueOnce(UNOBSERVED) // resolve poll 1 (trigger only)
      .mockResolvedValueOnce(UNOBSERVED) // corroboration status 1
      .mockResolvedValueOnce(UNOBSERVED) // corroboration status 2
      .mockResolvedValue(confirmedStatus()); // after the re-sign
    mocks.conn.getBlockHeight
      .mockResolvedValueOnce(WINDOW + 1) // past the window
      .mockResolvedValueOnce(WINDOW + 2) // still past, second check
      .mockResolvedValue(WINDOW + 1);
    mocks.conn.getMultipleAccountsInfo
      .mockResolvedValueOnce(gateRaw()) // gate
      .mockResolvedValueOnce([accountRaw(2000000)]) // corroboration read 1
      .mockResolvedValueOnce([accountRaw(2000000)]) // read 2: identical
      .mockResolvedValue([accountRaw(RESERVE)]); // verify after the re-sign
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("withdraw-verified");
    expect(result.current.lamportsAfterAction).toBe(RESERVE);
    expect(result.current.signatures).toHaveLength(2);
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.conn.getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(heldAction()).toBeNull();
  });

  it("lamports drift between the corroboration reads blocks the re-sign (asymmetric rule)", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight
      .mockResolvedValueOnce(WINDOW + 1)
      .mockResolvedValueOnce(WINDOW + 2);
    mocks.conn.getMultipleAccountsInfo
      .mockResolvedValueOnce(gateRaw()) // gate
      .mockResolvedValueOnce([accountRaw(2000000)]) // corroboration read 1
      .mockResolvedValue([accountRaw(1999440)]); // read 2: drifted
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("unresolved-outcome");
    expect(result.current.errorDetail).toContain(
      "lamports changed between the two corroboration reads"
    );
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.current.actionInFlight).toBe(true);
    expect(heldAction()).toBe("excess");
    // Dismissal is the only release from the unresolved terminal.
    await act(async () => {
      result.current.reset();
    });
    expect(heldAction()).toBeNull();
  });

  it("never re-signs while the blockhash window is still open", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW - 10);
    mocks.conn.getMultipleAccountsInfo.mockResolvedValue(gateRaw());
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      // Let a few resolution rounds run inside the window.
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.status).toBe("confirming");
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    // The transaction then lands and resolves normally.
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    mocks.conn.getMultipleAccountsInfo.mockResolvedValue([
      accountRaw(RESERVE),
    ]);
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("withdraw-verified");
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("a status resolving mid-corroboration wins over the re-sign", async () => {
    mocks.conn.getSignatureStatuses
      .mockResolvedValueOnce(UNOBSERVED) // resolve poll 1
      .mockResolvedValueOnce(UNOBSERVED) // corroboration status 1
      .mockResolvedValue(confirmedStatus()); // corroboration status 2
    mocks.conn.getBlockHeight.mockResolvedValueOnce(WINDOW + 1);
    mocks.conn.getMultipleAccountsInfo
      .mockResolvedValueOnce(gateRaw()) // gate
      .mockResolvedValueOnce([accountRaw(2000000)]) // corroboration read 1
      .mockResolvedValue([accountRaw(RESERVE)]); // verify
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("withdraw-verified");
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("a mid-corroboration on-chain error resolves to on-chain-failure", async () => {
    mocks.conn.getSignatureStatuses
      .mockResolvedValueOnce(UNOBSERVED) // resolve poll 1
      .mockResolvedValueOnce(UNOBSERVED) // corroboration status 1
      .mockResolvedValue({
        value: [
          { err: "InstructionError", confirmationStatus: "confirmed" },
        ],
      }); // corroboration status 2
    mocks.conn.getBlockHeight.mockResolvedValueOnce(WINDOW + 1);
    mocks.conn.getMultipleAccountsInfo
      .mockResolvedValueOnce(gateRaw()) // gate
      .mockResolvedValueOnce([accountRaw(2000000)]) // corroboration read 1
      .mockResolvedValue([accountRaw(2000000)]); // after-observation
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("on-chain-failure");
    expect(result.current.lamportsAfterAction).toBe(2000000);
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(heldAction()).toBeNull();
  });

  it("stops with an honest expired report after a second corroborated expiry", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight
      .mockResolvedValueOnce(WINDOW + 1)
      .mockResolvedValueOnce(WINDOW + 2)
      .mockResolvedValue(WINDOW + 1);
    mocks.conn.getMultipleAccountsInfo.mockResolvedValue(
      gateRaw()
    );
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("expired");
    expect(result.current.error).toContain("expired again");
    expect(result.current.error).toContain("still held its lamports");
    expect(result.current.lamportsAfterAction).toBe(2000000);
    // Exactly one re-sign: two attempts, no third.
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(heldAction()).toBeNull();
  });

  it("the second expiry finding the account gone routes to unattributed, never success", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight
      .mockResolvedValueOnce(WINDOW + 1)
      .mockResolvedValueOnce(WINDOW + 2)
      .mockResolvedValue(WINDOW + 1);
    mocks.conn.getMultipleAccountsInfo
      .mockResolvedValueOnce(gateRaw()) // gate
      .mockResolvedValueOnce([accountRaw(2000000)]) // first corroboration read 1
      .mockResolvedValueOnce([accountRaw(2000000)]) // first corroboration read 2
      .mockResolvedValueOnce([accountRaw(2000000)]) // second corroboration read 1
      .mockResolvedValueOnce([accountRaw(2000000)]) // second corroboration read 2
      .mockResolvedValue([null]); // second-expiry observation: gone
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("unattributed");
    expect(result.current.error).toContain(
      "Whether this app's transaction was involved could not be established"
    );
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(2);
    expect(heldAction()).toBeNull();
  });

  it("an expiry-shaped wallet refusal retries once with a fresh transaction", async () => {
    const sign = vi.fn()
      .mockRejectedValueOnce(
        new Error("Transaction expired: block height exceeded")
      )
      .mockImplementation(async () => fakeSigned());
    mocks.wallet.signTransaction = sign;
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    mocks.conn.getMultipleAccountsInfo
      .mockResolvedValueOnce(gateRaw()) // gate
      .mockResolvedValue([accountRaw(RESERVE)]); // verify
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("withdraw-verified");
    expect(sign).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.conn.getLatestBlockhash).toHaveBeenCalledTimes(2);
  });

  it("a second expiry-shaped refusal stops without sending", async () => {
    const sign = vi.fn(async () => {
      throw new Error("Transaction expired: block height exceeded");
    });
    mocks.wallet.signTransaction = sign;
    mocks.conn.getMultipleAccountsInfo.mockResolvedValue(gateRaw());
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("expired");
    expect(result.current.error).toContain(
      "The wallet refused the request"
    );
    expect(result.current.error).toContain("Nothing was signed");
    expect(sign).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
    expect(heldAction()).toBeNull();
  });

  it("stops with a changed-wallet report when the wallet switches mid-flight", async () => {
    let resolveGate!: (read: unknown) => void;
    mocks.conn.getMultipleAccountsInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGate = resolve;
        })
    );
    const { result, rerender } = renderExcess();
    act(() => {
      void result.current.withdraw(CANDIDATE);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The wallet switches while the gate read is pending.
    mocks.wallet.publicKey = SWITCHED.publicKey;
    rerender();
    await act(async () => {
      resolveGate(gateRaw());
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.error).toContain(
      "The connected wallet changed. Stopped before signing anything."
    );
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
    expect(heldAction()).toBeNull();
  });

  it("a confirmed withdrawal whose follow-up read fails stays unverified with the receipt", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    mocks.conn.getMultipleAccountsInfo
      .mockResolvedValueOnce(gateRaw()) // gate
      .mockRejectedValue(new Error("rpc down")); // verify reads fail
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("confirmed-verification-unavailable");
    expect(result.current.lamportsAfterAction).toBeNull();
    expect(result.current.signatures).toHaveLength(1);
    expect(result.current.actionInFlight).toBe(false);
    // Confirmed-landed means only the read is missing: auto-release.
    expect(heldAction()).toBeNull();
  });

  it("a confirmed withdrawal whose follow-up read finds the account gone is unattributed", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    mocks.conn.getMultipleAccountsInfo
      .mockResolvedValueOnce(gateRaw()) // gate
      .mockResolvedValue([null]); // verify: no account at the address
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("unattributed");
    expect(result.current.error).toContain(
      "cannot tell what happened"
    );
    expect(result.current.lamportsAfterAction).toBeNull();
    expect(heldAction()).toBeNull();
  });

  it("a processed-only status routes to verification instead of keep-polling", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [{ err: null, confirmationStatus: "processed" }],
    });
    mocks.conn.getMultipleAccountsInfo
      .mockResolvedValueOnce(gateRaw()) // gate
      .mockResolvedValue([accountRaw(RESERVE)]); // verify
    const { result } = renderExcess();
    await act(async () => {
      void result.current.withdraw(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("withdraw-verified");
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

});
