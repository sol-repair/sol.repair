// @vitest-environment jsdom

/**
 * Lifecycle tests for useUnwrapNative (spec §10.3): the §8.3 gate, the
 * recorded observations, signing stages, the §8.5 non-landing evidence
 * standard with native substitutions (spaced null statuses, spaced
 * account reads, lamports-identical corroboration, the asymmetric
 * rule), the §8.9 terminal outcomes, and the §8.11 mutex — its
 * hold-until-dismiss and its release points, shared with the other two
 * action flows.
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
import { NATIVE_MINT } from "@solana/spl-token";

import {
  acquireAction,
  heldAction,
  releaseAction,
} from "../src/lib/actionMutex";
import { useUnwrapNative, type UnwrapState } from "../src/hooks/useUnwrapNative";
import { useRevokeDelegate } from "../src/hooks/useRevokeDelegate";
import { useRepairWallet } from "../src/hooks/useRepairWallet";
import type { ClosableAccount } from "../src/lib/solana/tokenAccounts";
import { TOKEN_PROGRAM_ID } from "../src/lib/solana/tokenAccounts";
import { ALREADY_CLOSED_COPY } from "../src/lib/solana/unwrapNative";

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
const OTHER = Keypair.generate().publicKey.toBase58();
const WINDOW = 1000;

const CANDIDATE = {
  pubkey: ACCOUNT.toBase58(),
  mint: NATIVE_MINT.toBase58(),
  program: "spl" as const,
  lamports: 2488440,
  amountAtScan: "250000000",
  decimals: 9,
};

const DELEGATION = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  balanceAtScan: "1000000",
  decimals: 6,
  lamports: 2039280,
  program: "spl" as const,
  delegate: DELEGATE,
};

/** A parsed-RPC single-account read of a NATIVE token account.
 *  delegate/closeAuthority omitted = absent. */
const parsedAccount = (over: {
  amount?: string;
  lamports?: number;
  owner?: string;
  mint?: string;
  isNative?: boolean;
  state?: string;
  delegate?: string | null;
  closeAuthority?: string | null;
} = {}) => ({
  value: {
    lamports: over.lamports ?? 2488440,
    owner: TOKEN_PROGRAM_ID,
    data: {
      parsed: {
        info: {
          mint: over.mint ?? NATIVE_MINT.toBase58(),
          owner: over.owner ?? OWNER.publicKey.toBase58(),
          tokenAmount: {
            amount: over.amount ?? "250000000",
            decimals: 9,
            uiAmount: null,
            uiAmountString: "0",
          },
          ...(over.delegate === undefined
            ? {}
            : over.delegate === null
              ? {}
              : { delegate: over.delegate }),
          ...(over.closeAuthority === undefined
            ? {}
            : { closeAuthority: over.closeAuthority }),
          state: over.state ?? "initialized",
          isNative: over.isNative ?? true,
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
  releaseAction("unwrap");
  releaseAction("revoke");
  releaseAction("repair");
  mocks.holder.publicKey = OWNER.publicKey;
  mocks.holder.signTransaction = signWith;
  // Default read: the native account present, confirmed native.
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
  releaseAction("unwrap");
  releaseAction("revoke");
  releaseAction("repair");
  vi.useRealTimers();
});

function renderUnwrap() {
  return renderHook(() => useUnwrapNative());
}

async function flushUntil(
  result: { current: UnwrapState | undefined },
  until: (status: UnwrapState["status"]) => boolean,
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

describe("verified unwrap and the recorded observations (§10.3.1, §8.2)", () => {
  it("reports a verified unwrap: gate → sign → send → confirmed → account gone", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce({ value: null }); // verify: account gone
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("unwrap-verified");
    expect(result.current.accountPubkey).toBe(CANDIDATE.pubkey);
    expect(result.current.amountAtScan).toBe("250000000");
    expect(result.current.lamportsAtScan).toBe(2488440);
    expect(result.current.amountBeforeAction).toBe("250000000");
    expect(result.current.lamportsBeforeAction).toBe(2488440);
    expect(result.current.accountPresentAfterAction).toBe(false);
    expect(result.current.signatures).toHaveLength(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(signWith).toHaveBeenCalledTimes(1);
  });

  it("reports already-closed when the gate finds the account missing — nothing was signed (§10.3.2)", async () => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue({ value: null });
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("already-closed");
    expect(result.current.error).toBe(ALREADY_CLOSED_COPY);
    expect(result.current.accountPresentAfterAction).toBe(false);
    expect(result.current.signatures).toHaveLength(0);
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
    expect(signWith).not.toHaveBeenCalled();
  });

  it("proceeds when the figures changed before the action (Case B, §10.3.4)", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(
        parsedAccount({ amount: "240000000", lamports: 2591200 })
      ) // gate: drifted
      .mockResolvedValueOnce({ value: null }); // verify: gone
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("unwrap-verified");
    // Both figures recorded: the scan's and the gate's — the card shows
    // both; the hook never aborts on drift.
    expect(result.current.amountAtScan).toBe("250000000");
    expect(result.current.lamportsAtScan).toBe(2488440);
    expect(result.current.amountBeforeAction).toBe("240000000");
    expect(result.current.lamportsBeforeAction).toBe(2591200);
  });

  it("never signs when signTransaction is absent (§10.2.6)", async () => {
    mocks.holder.signTransaction = null;
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("cancelled");
    expect(result.current.error).toContain(
      "Wallet not connected or does not support signing."
    );
    expect(mocks.conn.getLatestBlockhash).not.toHaveBeenCalled();
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("the refresh gate (§10.3.3, §8.3)", () => {
  const expectGateAbort = async (
    read: unknown,
    expectedFragment: string
  ) => {
    mocks.conn.getParsedAccountInfo.mockResolvedValue(read);
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("gate-state-changed");
    expect(result.current.error).toContain(expectedFragment);
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
    expect(signWith).not.toHaveBeenCalled();
  };

  it("aborts on an unreadable parse", async () => {
    await expectGateAbort(parsedAccount({ amount: "12.5" }), "could not be read");
  });

  it("aborts on a foreign wallet-owner", async () => {
    await expectGateAbort(
      parsedAccount({ owner: SWITCHED.publicKey.toBase58() }),
      "no longer owned by the connected wallet"
    );
  });

  it("aborts on a foreign close authority", async () => {
    await expectGateAbort(
      parsedAccount({ closeAuthority: OTHER }),
      "close authority"
    );
  });

  it("aborts on an impossible frozen observation", async () => {
    await expectGateAbort(parsedAccount({ state: "frozen" }), "frozen");
  });

  it("aborts when the live nativeStatus is non-native", async () => {
    await expectGateAbort(
      parsedAccount({ isNative: false }),
      "could not confirm this account is a wrapped-SOL account"
    );
  });

  it("aborts when the live nativeStatus is unknown", async () => {
    const raw = parsedAccount({});
    const info = (
      raw.value.data as { parsed: { info: Record<string, unknown> } }
    ).parsed.info;
    delete info.isNative;
    await expectGateAbort(
      raw,
      "could not confirm this account is a wrapped-SOL account"
    );
  });

  it("aborts on a mint mismatch", async () => {
    await expectGateAbort(
      parsedAccount({ mint: OTHER }),
      "different mint"
    );
  });

  it("aborts without signing when the read RPC fails", async () => {
    mocks.conn.getParsedAccountInfo.mockRejectedValue(new Error("429"));
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("gate-state-changed");
    expect(result.current.error).toBe(
      "The current account state could not be read. Nothing was signed."
    );
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("signing stages (§10.2.8, §8.5 message shapes)", () => {
  it("a user rejection is a cancelled nothing-sent action", async () => {
    mocks.holder.signTransaction = vi.fn(async () => {
      throw new Error("User rejected the request.");
    });
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
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
      .mockResolvedValueOnce({ value: null }); // verify
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("unwrap-verified");
    expect(sign).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("a raw wallet error keeps the raw text out of the main line", async () => {
    mocks.holder.signTransaction = vi.fn(async () => {
      throw new Error("wallet popup blocked");
    });
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.error).toContain("Nothing was signed or sent.");
    expect(result.current.errorDetail).toContain("wallet popup blocked");
  });

  it("stops with a changed-wallet report when the wallet switches mid-flight (§10.2.7)", async () => {
    let resolveGate!: (read: unknown) => void;
    mocks.conn.getParsedAccountInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGate = resolve;
        })
    );
    const { result, rerender } = renderUnwrap();
    act(() => {
      void result.current.unwrap(CANDIDATE);
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
});

describe("the §8.5 non-landing evidence standard, native substitutions", () => {
  it("10.3.5 — re-signs once when every corroboration read is unanimous", async () => {
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
      .mockResolvedValueOnce(parsedAccount()) // corroboration read 2 (identical lamports)
      .mockResolvedValueOnce({ value: null }); // verify after re-sign
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("unwrap-verified");
    expect(signWith).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.conn.getLatestBlockhash).toHaveBeenCalledTimes(2);
  });

  it("10.3.6 — never re-signs while the blockhash window is still open", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW - 10);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      // Let a few polls run.
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.status).toBe("confirming");
    expect(signWith).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    // The transaction then lands and resolves normally.
    mocks.conn.getSignatureStatuses.mockResolvedValue(CONFIRMED);
    mocks.conn.getParsedAccountInfo.mockResolvedValue({ value: null });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("unwrap-verified");
    expect(signWith).toHaveBeenCalledTimes(1);
  });

  it("10.3.7 — account gone past the window with no status: close-unattributed, NO re-sign", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW + 1);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce({ value: null }); // corroboration read 1: gone
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("close-unattributed");
    expect(result.current.error).toContain(
      "Whether this app's transaction closed it could not be established."
    );
    expect(result.current.accountPresentAfterAction).toBe(false);
    expect(signWith).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("10.3.8 — lamports drift between the corroboration reads blocks the re-sign (asymmetric rule)", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight
      .mockResolvedValueOnce(WINDOW + 1)
      .mockResolvedValueOnce(WINDOW + 2);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount()) // corroboration read 1
      .mockResolvedValueOnce(parsedAccount({ lamports: 999999 })); // read 2: drift
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("unresolved-outcome");
    expect(result.current.errorDetail).toContain(
      "lamports changed between the two corroboration reads"
    );
    expect(signWith).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("10.3.8 — a status resolving mid-corroboration wins (row 4)", async () => {
    mocks.conn.getSignatureStatuses
      .mockResolvedValueOnce(UNOBSERVED) // poll 1 (trigger only)
      .mockResolvedValueOnce(UNOBSERVED) // corroboration status 1
      .mockResolvedValueOnce(CONFIRMED); // corroboration status 2
    mocks.conn.getBlockHeight.mockResolvedValueOnce(WINDOW + 1);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount()) // corroboration read 1
      .mockResolvedValueOnce({ value: null }); // verify
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("unwrap-verified");
    expect(signWith).toHaveBeenCalledTimes(1);
  });

  it("10.3.8 — a mid-corroboration on-chain error resolves to row 6", async () => {
    mocks.conn.getSignatureStatuses
      .mockResolvedValueOnce(UNOBSERVED) // poll 1
      .mockResolvedValueOnce(UNOBSERVED) // corroboration status 1
      .mockResolvedValueOnce({
        value: [{ err: "InstructionError", confirmationStatus: "confirmed" }],
      }); // corroboration status 2
    mocks.conn.getBlockHeight.mockResolvedValueOnce(WINDOW + 1);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount()) // corroboration read 1
      .mockResolvedValueOnce(parsedAccount()); // on-chain-error observation
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("on-chain-failure");
    expect(signWith).toHaveBeenCalledTimes(1);
  });

  it("10.3.9 — stops with an honest expired report after a second corroborated expiry", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW + 1);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("expired");
    expect(result.current.error).toContain("expired again");
    expect(result.current.error).toContain("the account still existed");
    expect(result.current.accountPresentAfterAction).toBe(true);
    // Exactly one re-sign: two attempts, no third.
    expect(signWith).toHaveBeenCalledTimes(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it("10.3.9 — the second expiry finding the account gone routes to row 7, never to success", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW + 1);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount()) // first corroboration read 1
      .mockResolvedValueOnce(parsedAccount()) // first corroboration read 2
      .mockResolvedValueOnce(parsedAccount()) // second corroboration read 1
      .mockResolvedValueOnce(parsedAccount()) // second corroboration read 2
      .mockResolvedValueOnce({ value: null }); // second-expiry observation: gone
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "done");
    expect(result.current.outcome).toBe("close-unattributed");
    expect(signWith).toHaveBeenCalledTimes(2);
  });

  it("10.3.6/10.3.20 — stops with unresolved-outcome when every resolution read fails", async () => {
    mocks.conn.getSignatureStatuses.mockRejectedValue(new Error("down"));
    mocks.conn.getBlockHeight.mockResolvedValue(null);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("unresolved-outcome");
    expect(signWith).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("terminal outcomes after a confirmed status", () => {
  it("10.3.10 — an on-chain failure reports the observation separately; no success wording", async () => {
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [{ err: "InstructionError", confirmationStatus: "confirmed" }],
    });
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("on-chain-failure");
    expect(result.current.error).toContain("changed nothing");
    expect(result.current.accountPresentAfterAction).toBe(true);
    expect(signWith).toHaveBeenCalledTimes(1);
  });

  it("10.3.11 — a verification read failure after confirmed status stays unverified with the receipt", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockRejectedValue(new Error("rpc down")); // verify reads fail
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("confirmed-verification-unavailable");
    expect(result.current.accountPresentAfterAction).toBeNull();
    expect(result.current.signatures).toHaveLength(1);
    // Never rendered as success or failure.
    expect(result.current.status).toBe("unverified");
  });

  it("§8.5 — a confirmed close with an account back at the address is the recreation edge, credited to nobody", async () => {
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce(parsedAccount()) // verify read 1: present
      .mockResolvedValueOnce(parsedAccount()); // spaced read 2: still present
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "error");
    expect(result.current.outcome).toBe("recreated-after-close");
    expect(result.current.error).toContain("cannot tell what created it");
    expect(result.current.error).not.toMatch(/SOL\.REPAIR closed|we closed/);
    expect(result.current.accountPresentAfterAction).toBe(true);
  });
});

describe("the §8.11 action mutex across three flows", () => {
  it("10.3.13 — near-simultaneous initiation of all THREE actions has exactly one winner", async () => {
    // Direction 1: repair first, revoke and unwrap refused.
    const repair1 = renderHook(() => useRepairWallet());
    const revoke1 = renderHook(() => useRevokeDelegate());
    const unwrap1 = renderUnwrap();
    let repairPromise!: Promise<void>;
    let revokePromise!: Promise<void>;
    let unwrapPromise!: Promise<void>;
    act(() => {
      repairPromise = repair1.result.current.repair([closableAccount()], true);
      revokePromise = revoke1.result.current.revoke(DELEGATION);
      unwrapPromise = unwrap1.result.current.unwrap(CANDIDATE);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(unwrap1.result.current.outcome).toBe("action-conflict");
    expect(unwrap1.result.current.error).toContain(
      "Another wallet action is underway"
    );
    expect(revoke1.result.current.outcome).toBe("action-conflict");
    // The losers never build, sign, or send: zero receipts.
    expect(unwrap1.result.current.signatures).toHaveLength(0);
    expect(revoke1.result.current.signatures).toHaveLength(0);
    await act(async () => {
      await repairPromise;
      await revokePromise;
      await unwrapPromise;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(heldAction()).toBeNull();

    // Direction 2: unwrap first, repair refused.
    const repair2 = renderHook(() => useRepairWallet());
    const unwrap2 = renderUnwrap();
    let unwrapPromise2!: Promise<void>;
    let repairPromise2!: Promise<void>;
    act(() => {
      unwrapPromise2 = unwrap2.result.current.unwrap(CANDIDATE);
      repairPromise2 = repair2.result.current.repair([closableAccount()], true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(repair2.result.current.status).toBe("error");
    expect(repair2.result.current.error).toContain(
      "Another wallet action is underway"
    );
    // The unwrap (the winner) resolves: its gate read already passed on
    // the default account, the default statuses confirm, and the
    // switched read shows the account gone — a full verified run.
    mocks.conn.getParsedAccountInfo.mockResolvedValue({ value: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await unwrapPromise2;
      await repairPromise2;
    });
    await flushUntil(unwrap2.result, (s) => s === "done");
    expect(unwrap2.result.current.outcome).toBe("unwrap-verified");
    expect(heldAction()).toBeNull();
  });

  it("10.3.14 — auto-releases the lock at each safe terminal (done, expired, on-chain-failure, verification-unavailable)", async () => {
    // done / unwrap-verified
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockResolvedValueOnce({ value: null }); // verify
    {
      const { result } = renderUnwrap();
      await act(async () => {
        void result.current.unwrap(CANDIDATE);
        await vi.advanceTimersByTimeAsync(0);
      });
      await flushUntil(result, (s) => s === "done");
      expect(heldAction()).toBeNull();
    }
    cleanup();

    // error / expired — non-landing proven twice; nothing can land.
    mocks.conn.getSignatureStatuses.mockResolvedValue(UNOBSERVED);
    mocks.conn.getBlockHeight.mockResolvedValue(WINDOW + 1);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    {
      const { result } = renderUnwrap();
      await act(async () => {
        void result.current.unwrap(CANDIDATE);
        await vi.advanceTimersByTimeAsync(0);
      });
      await flushUntil(result, (s) => s === "error");
      expect(result.current.outcome).toBe("expired");
      expect(heldAction()).toBeNull();
    }
    cleanup();

    // error / on-chain-failure — landed and atomically reverted.
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [{ err: "InstructionError", confirmationStatus: "confirmed" }],
    });
    {
      const { result } = renderUnwrap();
      await act(async () => {
        void result.current.unwrap(CANDIDATE);
        await vi.advanceTimersByTimeAsync(0);
      });
      await flushUntil(result, (s) => s === "error");
      expect(result.current.outcome).toBe("on-chain-failure");
      expect(heldAction()).toBeNull();
    }
    cleanup();

    // unverified / confirmed-verification-unavailable — the transaction
    // is confirmed landed, so only the follow-up read is missing.
    // Contrast the hold-until-dismissal of unresolved-outcome below.
    mocks.conn.getSignatureStatuses.mockResolvedValue(CONFIRMED);
    mocks.conn.getParsedAccountInfo
      .mockResolvedValueOnce(parsedAccount()) // gate
      .mockRejectedValue(new Error("rpc down")); // verify reads fail
    {
      const { result } = renderUnwrap();
      await act(async () => {
        void result.current.unwrap(CANDIDATE);
        await vi.advanceTimersByTimeAsync(0);
      });
      await flushUntil(result, (s) => s === "unverified");
      expect(result.current.outcome).toBe(
        "confirmed-verification-unavailable"
      );
      expect(heldAction()).toBeNull();
    }
  });

  it("10.3.15 — unresolved-outcome holds the lock until reset(); fake timers never release it", async () => {
    mocks.conn.getSignatureStatuses.mockRejectedValue(new Error("down"));
    mocks.conn.getBlockHeight.mockResolvedValue(null);
    mocks.conn.getParsedAccountInfo.mockResolvedValue(parsedAccount());
    const { result } = renderUnwrap();
    await act(async () => {
      void result.current.unwrap(CANDIDATE);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushUntil(result, (s) => s === "unverified");
    expect(result.current.outcome).toBe("unresolved-outcome");
    expect(heldAction()).toBe("unwrap");
    // No timer-based release: minutes may pass, the lock stays.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });
    expect(heldAction()).toBe("unwrap");
    expect(anyOtherAcquireFails()).toBe(true);
    // Explicit dismissal is the only release.
    act(() => {
      result.current.reset();
    });
    expect(heldAction()).toBeNull();
    expect(anyOtherAcquireFails()).toBe(false);
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

/** Whether any other flow's initiation would be refused right now:
 *  can another kind take the lock? (Probe + immediate release.) */
function anyOtherAcquireFails(): boolean {
  const repairOk = acquireAction("repair");
  if (repairOk) releaseAction("repair");
  const revokeOk = acquireAction("revoke");
  if (revokeOk) releaseAction("revoke");
  return !(repairOk && revokeOk);
}
