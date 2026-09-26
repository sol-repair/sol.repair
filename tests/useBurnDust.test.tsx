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
import { useBurnDust } from "../src/hooks/useBurnDust";

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
