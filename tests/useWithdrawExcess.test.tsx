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
import { useWithdrawExcess } from "../src/hooks/useWithdrawExcess";

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
