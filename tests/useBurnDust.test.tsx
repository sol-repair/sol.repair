// @vitest-environment jsdom

/**
 * Hook tests for useBurnDust (docs/dust-zeroing-spec-draft.md Rev 1).
 * The lib's selection/gate/builder rules are pinned in burnDust.test.ts;
 * here the lifecycle is: the cross-action mutex, the in-lock gate, the
 * fee riding after the close (the owner's Q1 ruling), the honest
 * terminals, and the §8.11 lock hold on the unresolved outcome.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";

import { acquireAction, heldAction, releaseAction } from "../src/lib/actionMutex";
import { useBurnDust, type BurnState } from "../src/hooks/useBurnDust";

const mocks = vi.hoisted(() => ({
  wallet: {
    publicKey: null as PublicKey | null,
    signTransaction: null as ((tx: unknown) => Promise<unknown>) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
  conn: {
    getParsedAccountInfo: vi.fn(),
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

import { useRpcConnection } from "@/hooks/useRpcConnection";
void useRpcConnection;

const OWNER = Keypair.generate();
const SWITCHED = Keypair.generate();
const ACCOUNT = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;

const CANDIDATE = {
  pubkey: ACCOUNT.toBase58(),
  mint: MINT.toBase58(),
  program: "spl" as const,
  lamports: 2039280,
  amountAtScan: "5000",
  decimals: 6,
};

function readShape(over: Record<string, unknown> = {}) {
  return {
    value: {
      owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      lamports: 2039280,
      data: {
        parsed: {
          info: {
            mint: MINT.toBase58(),
            owner: OWNER.publicKey.toBase58(),
            tokenAmount: {
              amount: "5000",
              decimals: 6,
              uiAmount: 0.005,
              uiAmountString: "0.005",
            },
            state: "initialized",
            isNative: false,
          },
        },
      },
      ...over,
    },
  };
}

function gateRead() {
  return readShape();
}

/** After the send, the verification read must show the account GONE:
 *  the gate consumed the first getParsedAccountInfo call. */
function accountGoneAfterSend() {
  let calls = 0;
  mocks.conn.getParsedAccountInfo.mockImplementation(async () => {
    calls += 1;
    if (calls === 1) return gateRead();
    return { value: null };
  });
}

function fakeSigned() {
  const signature = bs58.encode(new Uint8Array(64).fill(7));
  return {
    signatures: [{ signature: bs58.decode(signature) }],
    serialize: () => new Uint8Array([1, 2, 3]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (heldAction()) releaseAction(heldAction()!);
  mocks.wallet.publicKey = OWNER.publicKey;
  mocks.wallet.signTransaction = vi.fn(async (tx) => {
    void tx;
    return fakeSigned();
  });
  mocks.conn.getLatestBlockhash.mockResolvedValue({
    blockhash: "BLOCKHASH",
    lastValidBlockHeight: 1000,
    feeCalculator: {},
  });
  mocks.conn.sendRawTransaction.mockResolvedValue("SIG");
  mocks.conn.getBlockHeight.mockResolvedValue(999);
});

afterEach(cleanup);

function confirmedStatus() {
  return { value: [{ err: null, confirmationStatus: "finalized" }] };
}

describe("useBurnDust lifecycle", () => {
  it("reports action-conflict when another action holds the mutex", async () => {
    expect(acquireAction("repair")).toBe(true);
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, false);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.outcome).toBe("action-conflict");
    expect(result.current.error).toContain("Another wallet action");
    expect(mocks.conn.getParsedAccountInfo).not.toHaveBeenCalled();
    releaseAction("repair");
  });

  it("aborts in-lock when the fresh read shows frozen (nothing signed)", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(
      readShape({
        data: {
          parsed: {
            info: {
              mint: MINT.toBase58(),
              owner: OWNER.publicKey.toBase58(),
              tokenAmount: {
                amount: "5000",
                decimals: 6,
                uiAmount: 0.005,
                uiAmountString: "0.005",
              },
              state: "frozen",
            },
          },
        },
      })
    );
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, false);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.outcome).toBe("gate-state-changed");
    expect(result.current.error).toContain("cannot be burned");
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
    expect(heldAction()).toBeNull();
  });

  it("verifies a clean burn end to end and appends the 1% fee when feeReady", async () => {
    accountGoneAfterSend();
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    const signedTxs: Array<{
      instructions: Array<{
        programId: PublicKey;
        data: Buffer;
        keys: Array<{ pubkey: PublicKey }>;
      }>;
    }> = [];
    mocks.wallet.signTransaction = vi.fn(async (tx: unknown) => {
      signedTxs.push(tx as { instructions: Array<{ programId: PublicKey; data: Buffer; keys: Array<{ pubkey: PublicKey }> }> });
      return fakeSigned();
    });
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, true);
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.outcome).toBe("burn-verified");
    expect(result.current.accountPresentAfterAction).toBe(false);
    // Three instructions: burn, closeAccount, then the 1% fee transfer.
    const tx = signedTxs[0];
    expect(tx.instructions).toHaveLength(3);
    expect(tx.instructions[0].data[0]).toBe(8);
    expect(tx.instructions[0].data.readBigUInt64LE(1)).toBe(5000n);
    expect(tx.instructions[1].data[0]).toBe(9);
    const fee = tx.instructions[2];
    expect(fee.programId.equals(SystemProgram.programId)).toBe(true);
    // The fee payer is the owner; the recipient is the published devnet
    // fee wallet (fees.ts), exactly as the repair charges it.
    expect(fee.keys[0].pubkey.equals(OWNER.publicKey)).toBe(true);
    expect(fee.keys[1].pubkey.toBase58()).toBe(
      "FXaMw3mBGkgKeu6wrhJCJCm1rKcMZcuMx6U19cvXAin4"
    );
    expect(heldAction()).toBeNull();
  });

  it("charges no fee when feeReady is false", async () => {
    accountGoneAfterSend();
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    const signedTxs: Array<{ instructions: unknown[] }> = [];
    mocks.wallet.signTransaction = vi.fn(async (tx: unknown) => {
      signedTxs.push(tx as { instructions: unknown[] });
      return fakeSigned();
    });
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, false);
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(signedTxs[0].instructions).toHaveLength(2);
  });

  it("burns the GATE balance, not the scan balance, when they drift", async () => {
    // Gate read shows the balance changed since the scan: Case B says
    // consent with current numbers.
    mocks.conn.getParsedAccountInfo.mockImplementation(async () => {
      return readShape({
        lamports: 2039280,
        data: {
          parsed: {
            info: {
              mint: MINT.toBase58(),
              owner: OWNER.publicKey.toBase58(),
              tokenAmount: {
                amount: "9000",
                decimals: 6,
                uiAmount: 0.009,
                uiAmountString: "0.009",
              },
              state: "initialized",
              isNative: false,
            },
          },
        },
      });
    });
    // Verification: the account is gone after the send.
    mocks.conn.getParsedAccountInfo.mockImplementation((() => {
      let calls = 0;
      return async () => {
        calls += 1;
        if (calls === 1) {
          return readShape({
            data: {
              parsed: {
                info: {
                  mint: MINT.toBase58(),
                  owner: OWNER.publicKey.toBase58(),
                  tokenAmount: {
                    amount: "9000",
                    decimals: 6,
                    uiAmount: 0.009,
                    uiAmountString: "0.009",
                  },
                  state: "initialized",
                  isNative: false,
                },
              },
            },
          });
        }
        return { value: null };
      };
    })());
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    const signedTxs: Array<{ instructions: Array<{ data: Buffer }> }> = [];
    mocks.wallet.signTransaction = vi.fn(async (tx: unknown) => {
      signedTxs.push(tx as { instructions: Array<{ data: Buffer }> });
      return fakeSigned();
    });
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, false);
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.balanceBeforeAction).toBe("9000");
    expect(signedTxs[0].instructions[0].data.readBigUInt64LE(1)).toBe(9000n);
  });

  it("reports unverified via the unresolved terminal and holds the lock until the dismissal", async () => {
    accountGoneAfterSend();
    // The outcome can never be established: every status query fails
    // while the block height is already past the transaction's window
    // (the §8.5 unresolved shape). Three bounded rounds of 1.5s each,
    // so the test budget is generous.
    mocks.conn.getSignatureStatuses.mockRejectedValue(new Error("rpc down"));
    mocks.conn.getBlockHeight.mockResolvedValue(5000);
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, false);
    });
    await waitFor(() => expect(result.current.status).toBe("unverified"));
    expect(result.current.outcome).toBe("unresolved-outcome");
    // The affordance must hold through the unresolved hold too (the
    // page's buttons stay disabled while the mutex is kept).
    expect(result.current.actionInFlight).toBe(true);
    // The unresolved terminal holds the lock (the §8.11 rule): it may
    // still land, so nothing else may start until the user dismisses.
    expect(heldAction()).toBe("burn");
    await act(async () => {
      result.current.reset();
    });
    expect(heldAction()).toBeNull();
  }, 30000);

  it("reports an on-chain failure atomically with the account observation", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(gateRead());
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [{ err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "finalized" }],
    });
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, false);
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.outcome).toBe("on-chain-failure");
    expect(result.current.accountPresentAfterAction).toBe(true);
  });

  it("reports already-empty as its own done terminal", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(
      readShape({
        data: {
          parsed: {
            info: {
              mint: MINT.toBase58(),
              owner: OWNER.publicKey.toBase58(),
              tokenAmount: {
                amount: "0",
                decimals: 6,
                uiAmount: 0,
                uiAmountString: "0",
              },
              state: "initialized",
              isNative: false,
            },
          },
        },
      })
    );
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, false);
    });
    expect(result.current.status).toBe("done");
    expect(result.current.outcome).toBe("already-empty");
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("uses the refusal-retry budget exactly once on an expiry-shaped refusal", async () => {
    accountGoneAfterSend();
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    const signCalls = vi.fn();
    mocks.wallet.signTransaction = vi.fn(async () => {
      signCalls();
      if (signCalls.mock.calls.length === 1) {
        throw new Error("Transaction expired: block height exceeded");
      }
      return fakeSigned();
    });
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, false);
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.outcome).toBe("burn-verified");
    // Exactly one fresh build+sign after the refusal, then the retry
    // note is cleared once the retry is actually sent (the sending
    // state resets the note by design).
    expect(signCalls.mock.calls).toHaveLength(2);
  });

  it("stops at recreated-after-close when a confirmed read finds an account again", async () => {
    // The gate passes, the tx confirms, and BOTH verification reads
    // find an account at the address: the closed-then-recreated edge.
    mocks.conn.getParsedAccountInfo.mockResolvedValue(gateRead());
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, false);
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.outcome).toBe("recreated-after-close");
    expect(result.current.accountPresentAfterAction).toBe(true);
    expect(result.current.error).toContain("Nothing more will be sent");
    expect(heldAction()).toBeNull();
  });

  it("reports close-unattributed when the account is gone with no confirmed status", async () => {
    // The gate passes, the send goes out, and then: every status query
    // unobserved, the block height past the window, and the first
    // corroboration read finds the account GONE. The state is good;
    // causation is not claimed (no confirmed signature exists).
    accountGoneAfterSend();
    mocks.conn.getSignatureStatuses.mockResolvedValue({ value: [] });
    mocks.conn.getBlockHeight.mockResolvedValue(5000);
    const { result } = renderHook(() => useBurnDust());
    await act(async () => {
      await result.current.burn(CANDIDATE, false);
    });
    await waitFor(() => expect(result.current.status).toBe("done"), {
      timeout: 20000,
    });
    expect(result.current.outcome).toBe("close-unattributed");
    expect(result.current.accountPresentAfterAction).toBe(false);
    expect(heldAction()).toBeNull();
  }, 30000);
});

/**
 * The §8.5 transition matrix, backfilled to match the useUnwrapNative /
 * useRevokeDelegate suites, which pin the same shared lifecycle for the
 * older flows. Only the RPC boundary and the wallet adapter are mocked;
 * the hook under test is the real one. Fake timers drive the poll and
 * corroboration-space intervals, so every branch runs instantly: the
 * unanimous corroboration re-sign, the asymmetric drift block, the
 * late-status win, the mid-corroboration on-chain error, the bounded
 * second-expiry terminals, the mid-flight wallet switch, the
 * processed-status totality rule, and the lock's release points.
 */
describe("the §8.5 evidence standard, the wallet switch, and remaining terminals (fake timers)", () => {
  const WINDOW = 1000;
  const UNOBSERVED = { value: [null] };

  beforeEach(() => {
    vi.useFakeTimers();
    // Wipe unconsumed Once-queues from earlier tests: a leftover queued
    // answer would silently shift every later read/status sequence.
    mocks.conn.getParsedAccountInfo.mockReset();
    mocks.conn.getLatestBlockhash.mockReset();
    mocks.conn.sendRawTransaction.mockReset();
    mocks.conn.getSignatureStatuses.mockReset();
    mocks.conn.getBlockHeight.mockReset();
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
    releaseAction("burn");
    vi.useRealTimers();
  });

  function renderBurn() {
    return renderHook(() => useBurnDust());
  }

  async function flushUntil(
    result: { current: BurnState | undefined },
    until: (status: BurnState["status"]) => boolean,
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
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(gateRead()) // gate
      .mockResolvedValueOnce(gateRead()) // corroboration read 1
      .mockResolvedValueOnce(gateRead()) // read 2: identical lamports
      .mockResolvedValue({ value: null }); // verify after the re-sign: gone
    const { result } = renderBurn();
    await act(async () => {
      void result.current.burn(CANDIDATE, false);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("burn-verified");
    expect(result.current.accountPresentAfterAction).toBe(false);
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
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(gateRead()) // gate
      .mockResolvedValueOnce(gateRead()) // corroboration read 1
      .mockResolvedValue(readShape({ lamports: 999999 })); // read 2: drift
    const { result } = renderBurn();
    await act(async () => {
      void result.current.burn(CANDIDATE, false);
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
    expect(heldAction()).toBe("burn");
    // Dismissal is the only release from the unresolved terminal.
    await act(async () => {
      result.current.reset();
    });
    expect(heldAction()).toBeNull();
  });

  it("never re-signs while the blockhash window is still open", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW - 10);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(gateRead());
    const { result } = renderBurn();
    await act(async () => {
      void result.current.burn(CANDIDATE, false);
      // Let a few resolution rounds run inside the window.
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.status).toBe("confirming");
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    // The transaction then lands and resolves normally.
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    mocks.conn.getParsedAccountInfo.mockResolvedValue({ value: null });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("burn-verified");
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("a status resolving mid-corroboration wins over the re-sign", async () => {
    mocks.conn.getSignatureStatuses
      .mockResolvedValueOnce(UNOBSERVED) // resolve poll 1
      .mockResolvedValueOnce(UNOBSERVED) // corroboration status 1
      .mockResolvedValue(confirmedStatus()); // corroboration status 2
    mocks.conn.getBlockHeight.mockResolvedValueOnce(WINDOW + 1);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(gateRead()) // gate
      .mockResolvedValueOnce(gateRead()) // corroboration read 1
      .mockResolvedValue({ value: null }); // verify: gone
    const { result } = renderBurn();
    await act(async () => {
      void result.current.burn(CANDIDATE, false);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("burn-verified");
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
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(gateRead()) // gate
      .mockResolvedValueOnce(gateRead()) // corroboration read 1
      .mockResolvedValue(gateRead()); // after-observation: present
    const { result } = renderBurn();
    await act(async () => {
      void result.current.burn(CANDIDATE, false);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("on-chain-failure");
    expect(result.current.accountPresentAfterAction).toBe(true);
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(heldAction()).toBeNull();
  });

  it("stops with an honest expired report after a second corroborated expiry", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight
      .mockResolvedValueOnce(WINDOW + 1)
      .mockResolvedValueOnce(WINDOW + 2)
      .mockResolvedValue(WINDOW + 1);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(gateRead());
    const { result } = renderBurn();
    await act(async () => {
      void result.current.burn(CANDIDATE, false);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("expired");
    expect(result.current.error).toContain("expired again");
    expect(result.current.error).toContain("the account still existed");
    expect(result.current.accountPresentAfterAction).toBe(true);
    // Exactly one re-sign: two attempts, no third.
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(heldAction()).toBeNull();
  });

  it("the second expiry finding the account gone routes to close-unattributed, never success", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight
      .mockResolvedValueOnce(WINDOW + 1)
      .mockResolvedValueOnce(WINDOW + 2)
      .mockResolvedValue(WINDOW + 1);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(gateRead()) // gate
      .mockResolvedValueOnce(gateRead()) // first corroboration read 1
      .mockResolvedValueOnce(gateRead()) // first corroboration read 2
      .mockResolvedValueOnce(gateRead()) // second corroboration read 1
      .mockResolvedValueOnce(gateRead()) // second corroboration read 2
      .mockResolvedValue({ value: null }); // second-expiry observation: gone
    const { result } = renderBurn();
    await act(async () => {
      void result.current.burn(CANDIDATE, false);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("close-unattributed");
    expect(result.current.accountPresentAfterAction).toBe(false);
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(2);
    expect(heldAction()).toBeNull();
  });

  it("stops with a changed-wallet report when the wallet switches mid-flight", async () => {
    let resolveGate!: (read: unknown) => void;
    mocks.conn.getParsedAccountInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGate = resolve;
        })
    );
    const { result, rerender } = renderBurn();
    act(() => {
      void result.current.burn(CANDIDATE, false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The wallet switches while the gate read is pending.
    mocks.wallet.publicKey = SWITCHED.publicKey;
    rerender();
    await act(async () => {
      resolveGate(gateRead());
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

  it("a confirmed burn whose follow-up read fails stays unverified with the receipt", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(confirmedStatus());
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(gateRead()) // gate
      .mockRejectedValue(new Error("rpc down")); // verify reads fail
    const { result } = renderBurn();
    await act(async () => {
      void result.current.burn(CANDIDATE, false);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("confirmed-verification-unavailable");
    expect(result.current.accountPresentAfterAction).toBeNull();
    expect(result.current.signatures).toHaveLength(1);
    expect(result.current.actionInFlight).toBe(false);
    // Confirmed-landed means only the read is missing: auto-release.
    expect(heldAction()).toBeNull();
  });

  it("a processed-only status routes to verification instead of keep-polling", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [{ err: null, confirmationStatus: "processed" }],
    });
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(gateRead()) // gate
      .mockResolvedValue({ value: null }); // verify: gone
    const { result } = renderBurn();
    await act(async () => {
      void result.current.burn(CANDIDATE, false);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("burn-verified");
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

});
