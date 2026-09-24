// @vitest-environment jsdom

/**
 * Lifecycle tests for useRevokeDelegate (spec §10.3): the gate, the
 * balance observations, signing stages, the §8.5 non-landing evidence
 * standard and its asymmetric rule, the terminal outcomes of §8.9, and
 * the §8.12 mutex — its hold-until-dismiss and its release points.
 *
 * Only the RPC boundary and the wallet adapter are mocked; the hook
 * under test is the real one. Fake timers drive the resolution loop's
 * poll intervals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
} from "@solana/web3.js";

import {
  acquireAction,
  heldAction,
  releaseAction,
} from "../src/lib/actionMutex";
import { useRevokeDelegate, type RevokeState } from "../src/hooks/useRevokeDelegate";
import { useRepairWallet } from "../src/hooks/useRepairWallet";
import type { ClosableAccount } from "../src/lib/solana/tokenAccounts";
import { TOKEN_PROGRAM_ID } from "../src/lib/solana/tokenAccounts";
import { ALREADY_REVOKED_COPY } from "../src/lib/solana/revokeDelegation";

const mocks = vi.hoisted(() => ({
  holder: {
    publicKey: null as PublicKey | null,
    signTransaction: null as
      | null
      | ((tx: Transaction) => Promise<Transaction>),
  },
  conn: {
    getParsedAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    getSignatureStatuses: vi.fn(),
    getBlockHeight: vi.fn(),
    getMultipleAccountsInfo: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.holder,
  useConnection: () => ({ connection: mocks.conn as unknown as Connection }),
}));

const OWNER = Keypair.generate();
const SWITCHED = Keypair.generate();
const ACCOUNT = Keypair.generate().publicKey;
const DELEGATE = Keypair.generate().publicKey.toBase58();
const WINDOW = 1000;

const DELEGATION = {
  pubkey: ACCOUNT.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  balanceAtScan: "1000000",
  decimals: 6,
  lamports: 2039280,
  program: "spl" as const,
  delegate: DELEGATE,
};

/** A parsed-RPC single-account read. delegate omitted = absent. */
const parsedAccount = (over: {
  delegate?: string | null;
  amount?: string;
  owner?: string;
  frozen?: boolean;
} = {}) => ({
  value: {
    lamports: 2039280,
    owner: TOKEN_PROGRAM_ID,
    data: {
      parsed: {
        info: {
          mint: Keypair.generate().publicKey.toBase58(),
          owner: over.owner ?? OWNER.publicKey.toBase58(),
          tokenAmount: {
            amount: over.amount ?? "1000000",
            decimals: 6,
            uiAmount: null,
            uiAmountString: "0",
          },
          ...(over.delegate === undefined
            ? { delegate: DELEGATE }
            : over.delegate === null
              ? {}
              : { delegate: over.delegate }),
          state: over.frozen ? "frozen" : "initialized",
          isNative: false,
        },
      },
    },
  },
});

const CONFIRMED = {
  value: [{ err: null, confirmationStatus: "confirmed" }],
};
const UNOBSERVED = { value: [null] };

const signWith = vi.fn(async (tx: Transaction) => {
  tx.sign(OWNER);
  return tx;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Wipe unconsumed Once-queues from earlier tests: a leftover queued
  // answer would silently shift every later read/status sequence.
  mocks.conn.getParsedAccountInfo.mockReset();
  mocks.conn.getLatestBlockhash.mockReset();
  mocks.conn.sendRawTransaction.mockReset();
  mocks.conn.getSignatureStatuses.mockReset();
  mocks.conn.getBlockHeight.mockReset();
  mocks.conn.getMultipleAccountsInfo.mockReset();
  releaseAction("revoke");
  releaseAction("repair");
  mocks.holder.publicKey = OWNER.publicKey;
  mocks.holder.signTransaction = signWith;
  // Default read: the reviewed delegate present.
  mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
  mocks.conn.getLatestBlockhash.mockResolvedValue({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: WINDOW,
  });
  mocks.conn.sendRawTransaction.mockResolvedValue("unused");
  // Default resolution: confirmed on the first poll, window open.
  mocks.conn.getSignatureStatuses.mockResolvedValue(CONFIRMED);
  mocks.conn.getBlockHeight.mockResolvedValue(WINDOW - 10);
});

afterEach(() => {
  cleanup();
  // The module-scoped mutex outlives a test; never leak a hold into
  // the next test (an unresolved terminal intentionally keeps it).
  releaseAction("revoke");
  releaseAction("repair");
  vi.useRealTimers();
});

function renderRevoke() {
  return renderHook(() => useRevokeDelegate());
}

async function flushUntil(
  result: { current: RevokeState | undefined },
  until: (status: RevokeState["status"]) => boolean,
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

describe("verified revocation and the balance observations (§8.2)", () => {
  it("reports a verified revocation with matching recorded reads (Case A)", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount({ delegate: null })); // verify
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("revoked-verified");
    expect(result.current.balanceAtScan).toBe("1000000");
    expect(result.current.balanceBeforeAction).toBe("1000000");
    expect(result.current.balanceAfterAction).toBe("1000000");
    expect(result.current.delegatePresentAtLastRead).toBe(false);
    expect(result.current.signatures).toHaveLength(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(signWith).toHaveBeenCalledTimes(1);
  });

  it("reports already-revoked when the gate finds the delegate absent", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(
      parsedAccount({ delegate: null })
    );
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("already-revoked");
    expect(result.current.error).toBe(ALREADY_REVOKED_COPY);
    expect(result.current.balanceBeforeAction).toBe("1000000");
    expect(result.current.signatures).toHaveLength(0);
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
    expect(signWith).not.toHaveBeenCalled();
  });

  it("proceeds when the balance changed before the action (Case B)", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount({ amount: "900000" })) // gate
      .mockResolvedValueOnce(parsedAccount({ delegate: null, amount: "900000" })); // verify
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("revoked-verified");
    expect(result.current.balanceAtScan).toBe("1000000");
    expect(result.current.balanceBeforeAction).toBe("900000");
    expect(result.current.balanceAfterAction).toBe("900000");
  });

  it("records the after-observation when the balance changed across the transaction (Case C)", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(
        parsedAccount({ delegate: null, amount: "700000" })
      ); // verify
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("revoked-verified");
    expect(result.current.balanceBeforeAction).toBe("1000000");
    expect(result.current.balanceAfterAction).toBe("700000");
  });

  it("keeps the revocation verified when the balance read fails (Case D)", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockRejectedValue(new Error("rpc down")); // verify reads 1+2
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("confirmed-verification-unavailable");
    expect(result.current.signatures).toHaveLength(1);
    expect(result.current.balanceAfterAction).toBeNull();
  });

  it("stays unverified when the account vanishes before the verification read", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce({ value: null }) // verify read 1: account gone
      .mockResolvedValueOnce({ value: null }); // spaced read 2: still gone
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("confirmed-verification-unavailable");
    expect(result.current.error).toMatch(/could no longer be read/);
  });

  it("reports honestly when a delegate reappears after a confirmed revoke", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValue(parsedAccount()); // verify reads 1+2: still present
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("delegate-reapproved-after");
    expect(result.current.delegatePresentAtLastRead).toBe(true);
    expect(result.current.error).toMatch(/cannot tell what set it/);
    expect(result.current.error).not.toMatch(/another authority|re-approved/);
  });

  it("routes a processed-only status to verification instead of keep-polling", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [{ err: null, confirmationStatus: "processed" }],
    });
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount({ delegate: null })); // verify
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("revoked-verified");
    // Landed is landed: no window evaluation, no corroboration reads.
    expect(mocks.conn.getBlockHeight).not.toHaveBeenCalled();
    expect(signWith).toHaveBeenCalledTimes(1);
  });

  it("gives a missing account after a provable expiry its own terminal", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW + 1);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce({ value: null }); // corroboration read 1
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("account-gone");
    expect(result.current.error).toContain(
      "The transaction expired without landing, and the account could not be found"
    );
    expect(result.current.error).not.toContain("may still land");
    expect(signWith).toHaveBeenCalledTimes(1);
  });
});

describe("the refresh gate (§8.3)", () => {
  const expectGateAbort = async (
    read: unknown,
    expectedFragment: string
  ) => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(read);
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("gate-state-changed");
    expect(result.current.error).toContain(expectedFragment);
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
    expect(signWith).not.toHaveBeenCalled();
  };

  it("aborts on a missing account", async () => {
    await expectGateAbort({ value: null }, "no longer exists");
  });

  it("aborts on an unreadable account", async () => {
    await expectGateAbort(
      parsedAccount({ amount: "12.5" }),
      "could not be read"
    );
  });

  it("aborts on a frozen account", async () => {
    await expectGateAbort(parsedAccount({ frozen: true }), "now frozen");
  });

  it("aborts when the delegate changed, naming the new address", async () => {
    const newDelegate = Keypair.generate().publicKey.toBase58();
    await expectGateAbort(
      parsedAccount({ delegate: newDelegate }),
      newDelegate
    );
  });

  it("aborts when the account is no longer owned by the connected wallet", async () => {
    await expectGateAbort(
      parsedAccount({ owner: SWITCHED.publicKey.toBase58() }),
      "no longer owned by the connected wallet"
    );
  });

  it("aborts without signing when the read RPC fails", async () => {
    mocks.conn.getParsedAccountInfo.mockRejectedValue(new Error("429"));
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.error).toContain(
      "The current account state could not be read. Nothing was signed."
    );
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("signing stages (§8.5 message shapes, the one allowed place)", () => {
  it("a user rejection is a cancelled nothing-sent action", async () => {
    mocks.holder.signTransaction = vi.fn(async () => {
      throw new Error("User rejected the request.");
    });
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("cancelled");
    expect(result.current.error).toBe("Transaction cancelled. Nothing was sent.");
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("an expiry-shaped wallet refusal retries once with a fresh transaction", async () => {
    const sign = vi.fn()
      .mockRejectedValueOnce(new Error("Transaction expired"))
      .mockImplementationOnce(async (tx: Transaction) => {
        tx.sign(OWNER);
        return tx;
      });
    mocks.holder.signTransaction = sign;
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount({ delegate: null })); // verify
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("revoked-verified");
    expect(sign).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("a second expiry-shaped refusal stops without sending", async () => {
    const sign = vi.fn(async () => {
      throw new Error("TransactionExpiredBlockheightExceededError");
    });
    mocks.holder.signTransaction = sign;
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("expired");
    expect(result.current.error).toContain("Nothing was signed.");
    expect(sign).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a raw wallet error keeps the raw text out of the main line", async () => {
    mocks.holder.signTransaction = vi.fn(async () => {
      throw new Error("wallet popup blocked");
    });
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.error).toContain("Nothing was signed or sent.");
    expect(result.current.errorDetail).toContain("wallet popup blocked");
  });
});

describe("the §8.5 non-landing evidence standard", () => {
  it("re-signs once when every corroboration read is unanimous (§10.3.17)", async () => {
    mocks.conn.getSignatureStatuses
      .mockResolvedValueOnce(UNOBSERVED) // poll 1 (trigger only — not counted)
      .mockResolvedValueOnce(UNOBSERVED) // corroboration status 1 (post-close)
      .mockResolvedValueOnce(UNOBSERVED) // corroboration status 2 (post-close)
      .mockResolvedValueOnce(CONFIRMED); // after the re-sign
    mocks.conn.getBlockHeight
      .mockResolvedValueOnce(WINDOW + 1) // past the window
      .mockResolvedValueOnce(WINDOW + 2); // still past, second check
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount()) // corroboration read 1
      .mockResolvedValueOnce(parsedAccount()) // corroboration read 2
      .mockResolvedValueOnce(parsedAccount({ delegate: null })); // verify
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("revoked-verified");
    expect(signWith).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.conn.getLatestBlockhash).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-sign when the account read proves the delegate absent (§10.3.18)", async () => {
    mocks.conn.getSignatureStatuses
      .mockResolvedValueOnce(UNOBSERVED)
      .mockResolvedValueOnce(UNOBSERVED);
    mocks.conn.getBlockHeight
      .mockResolvedValueOnce(WINDOW + 1)
      .mockResolvedValueOnce(WINDOW + 2);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount({ delegate: null })); // read 1
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("delegate-absent-unattributed");
    expect(result.current.error).toMatch(/could not be established/);
    expect(signWith).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("lets a late-resolving status win over the re-sign (§10.3.19)", async () => {
    mocks.conn.getSignatureStatuses
      .mockResolvedValueOnce(UNOBSERVED) // poll 1 (trigger only)
      .mockResolvedValueOnce(UNOBSERVED) // corroboration status 1
      .mockResolvedValueOnce(CONFIRMED); // corroboration status 2
    mocks.conn.getBlockHeight.mockResolvedValueOnce(WINDOW + 1);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount()) // corroboration read 1
      .mockResolvedValueOnce(parsedAccount({ delegate: null })); // verify
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("revoked-verified");
    expect(signWith).toHaveBeenCalledTimes(1);
  });

  it("reports uncertainty when the status path fails during corroboration (§10.3.20)", async () => {
    mocks.conn.getSignatureStatuses
      .mockResolvedValueOnce(UNOBSERVED) // poll 1
      .mockRejectedValue(new Error("rpc down")); // corroboration status 2 (3 attempts)
    mocks.conn.getBlockHeight.mockResolvedValueOnce(WINDOW + 1);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValue(parsedAccount()); // corroboration read 1
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("unresolved-outcome");
    expect(signWith).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("never re-signs while the blockhash window is still open (§10.3.6)", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW - 10);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      // Let a few polls run.
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.status).toBe("confirming");
    expect(signWith).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    // The transaction then lands and resolves normally.
    mocks.conn.getSignatureStatuses.mockResolvedValue(CONFIRMED);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(
      parsedAccount({ delegate: null })
    );
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("revoked-verified");
    expect(signWith).toHaveBeenCalledTimes(1);
  });

  it("stops with an honest expired report after a second corroborated expiry (§10.3.9)", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW + 1);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("expired");
    expect(result.current.error).toContain("expired again");
    expect(result.current.delegatePresentAtLastRead).toBe(true);
    expect(signWith).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it("reports the absent-delegate outcome when the second expiry finds it gone", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW + 1);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount()) // first corroboration read 1
      .mockResolvedValueOnce(parsedAccount()) // first corroboration read 2
      .mockResolvedValueOnce(parsedAccount()) // second corroboration read 1
      .mockResolvedValueOnce(parsedAccount({ delegate: null })); // second read 2
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("delegate-absent-unattributed");
    expect(signWith).toHaveBeenCalledTimes(2);
  });

  it("stops and reports uncertainty when every resolution read fails (§10.3.20)", async () => {
    mocks.conn.getSignatureStatuses.mockRejectedValue(new Error("down"));
    mocks.conn.getBlockHeight.mockResolvedValue(null);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("unresolved-outcome");
    expect(signWith).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("on-chain failure (§8.9 row 6)", () => {
  it("reports the transaction failure separately from the account observation", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [{ err: "InstructionError", confirmationStatus: "confirmed" }],
    });
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("on-chain-failure");
    expect(result.current.error).toContain("changed nothing");
    expect(result.current.delegatePresentAtLastRead).toBe(true);
    expect(signWith).toHaveBeenCalledTimes(1);
  });
});

describe("the §8.12 action mutex", () => {
  it("no-ops a second revoke while one is in flight (same-hook guard)", async () => {
    let releaseSign!: (tx: Transaction) => void;
    const deferredSign = vi.fn(
      () =>
        new Promise<Transaction>((resolve) => {
          releaseSign = resolve;
        })
    );
    mocks.holder.signTransaction = deferredSign;
    const { result } = renderRevoke();
    let first!: Promise<void>;
    act(() => {
      first = result.current.revoke(DELEGATION);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("awaiting-signature");
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(deferredSign).toHaveBeenCalledTimes(1);
    await act(async () => {
      const tx = new Transaction();
      tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
      tx.feePayer = OWNER.publicKey;
      tx.sign(OWNER);
      releaseSign(tx);
      // Drive the post-signing flow's settle sleeps to completion so
      // this action terminates inside the test (no orphaned timers).
      await vi.advanceTimersByTimeAsync(10_000);
      await first;
    });
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
    const { result, rerender } = renderRevoke();
    act(() => {
      void result.current.revoke(DELEGATION);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The wallet switches while the gate read is pending.
    mocks.holder.publicKey = SWITCHED.publicKey;
    rerender();
    await act(async () => {
      resolveGate(parsedAccount());
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.error).toContain(
      "The connected wallet changed. Stopped before signing anything."
    );
    expect(signWith).not.toHaveBeenCalled();
  });

  it("holds the lock through an unresolved outcome and releases only on dismissal (§10.3.21)", async () => {
    mocks.conn.getSignatureStatuses.mockRejectedValue(new Error("down"));
    mocks.conn.getBlockHeight.mockResolvedValue(null);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("unresolved-outcome");
    expect(heldAction()).toBe("revoke");
    // No timer-based release: minutes may pass, the lock stays.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });
    expect(heldAction()).toBe("revoke");
    expect(acquireRepairFails()).toBe(true);
    // Explicit dismissal is the only release.
    act(() => {
      result.current.reset();
    });
    expect(heldAction()).toBeNull();
    expect(acquireRepairFails()).toBe(false);
  });

  it("auto-releases the lock at a safe terminal", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount())
      .mockResolvedValueOnce(parsedAccount({ delegate: null }));
    const { result } = renderRevoke();
    await act(async () => {
      void result.current.revoke(DELEGATION);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(heldAction()).toBeNull();
  });

  it("makes near-simultaneous initiation single-winner in both directions (§10.3.15)", async () => {
    // Direction 1: repair first, revoke refused.
    const repair1 = renderHook(() => useRepairWallet());
    const revoke1 = renderRevoke();
    let repairPromise!: Promise<void>;
    let revokePromise!: Promise<void>;
    act(() => {
      repairPromise = repair1.result.current.repair([closableAccount()], true);
      revokePromise = revoke1.result.current.revoke(DELEGATION);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(revoke1.result.current.outcome).toBe("action-conflict");
    expect(revoke1.result.current.error).toContain(
      "Another wallet action is underway"
    );
    // The repair (the winner) proceeds; the refused revoke never signs.
    expect(revoke1.result.current.signatures).toHaveLength(0);
    await act(async () => {
      await repairPromise;
      await revokePromise;
    });
    expect(repair1.result.current.status).toBe("done");
    expect(heldAction()).toBeNull();

    // Direction 2: revoke first, repair refused.
    const repair2 = renderHook(() => useRepairWallet());
    const revoke2 = renderRevoke();
    let revokePromise2!: Promise<void>;
    let repairPromise2!: Promise<void>;
    act(() => {
      revokePromise2 = revoke2.result.current.revoke(DELEGATION);
      repairPromise2 = repair2.result.current.repair([closableAccount()], true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(repair2.result.current.status).toBe("error");
    expect(repair2.result.current.error).toContain(
      "Another wallet action is underway"
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await revokePromise2;
      await repairPromise2;
    });
    expect(heldAction()).toBeNull();
  });
});

function closableAccount(): ClosableAccount {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: 2039280,
    program: "spl",
  };
}

/** Whether the repair hook's initiation would be refused right now:
 *  can the repair side take the lock? (Probe + immediate release.) */
function acquireRepairFails(): boolean {
  const ok = acquireAction("repair");
  if (ok) releaseAction("repair");
  return !ok;
}
