// @vitest-environment jsdom

/**
 * Concurrency and wallet-identity tests for useRepairWallet.
 *
 * Two risks are guarded here:
 *
 * 1. No concurrency guard: two repair() calls started back to back would
 *    both race through building, signing, and submitting. The second call
 *    must be a no-op while the first is in flight, and the guard must be
 *    released when the first run FAILS (not only when it succeeds), so a
 *    cancelled approval cannot brick future repairs.
 *
 * 2. Wallet identity re-read per batch: the hook read wallet.publicKey
 *    inside the batch loop, so a wallet switch mid-repair silently built
 *    the remaining batches for the NEW wallet. The run must keep using
 *    the wallet it started with, and stop with a clear report instead of
 *    silently switching identities.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
} from "@solana/web3.js";

import { useRepairWallet } from "../src/hooks/useRepairWallet";
import {
  TOKEN_PROGRAM_ID,
  type ClosableAccount,
} from "../src/lib/solana/tokenAccounts";

const mocks = vi.hoisted(() => ({
  holder: {
    publicKey: null as PublicKey | null,
    signTransaction: null as
      | null
      | ((tx: Transaction) => Promise<Transaction>),
  },
  conn: {
    getAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    confirmTransaction: vi.fn(),
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => mocks.holder,
  useConnection: () => ({ connection: mocks.conn as unknown as Connection }),
}));

const KEYPAIR_A = Keypair.generate();
const BLOCKHASH = PublicKey.default.toBase58();

const ACCOUNT: ClosableAccount = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  lamports: 2039280,
  program: "spl",
};

// On-chain state used by verifyAccountsClosed: every account is still
// open, owned by the classic token program.
const STILL_OPEN = {
  lamports: 0,
  owner: TOKEN_PROGRAM_ID,
  executable: false,
  data: Buffer.alloc(0),
  rentEpoch: 0,
};

function makeAccounts(count: number): ClosableAccount[] {
  return Array.from({ length: count }, (_, i) => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: 2039280,
    program: i % 2 === 0 ? "spl" : "token-2022",
  }));
}

describe("useRepairWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.holder.publicKey = KEYPAIR_A.publicKey;
    mocks.conn.getLatestBlockhash.mockResolvedValue({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1000,
    });
    mocks.conn.sendRawTransaction.mockResolvedValue("signed-tx-id");
    mocks.conn.confirmTransaction.mockResolvedValue({ value: { err: null } });
    mocks.conn.getAccountInfo.mockResolvedValue(STILL_OPEN);
  });

  afterEach(() => {
    cleanup();
  });

  it("ignores a second repair while one is in flight, and releases the lock after a failure", async () => {
    // signTransaction hangs until the test settles it, so the first repair
    // sits at the approval step and the test controls the timing.
    const deferreds: Array<{
      resolve: (tx: Transaction) => void;
      reject: (reason: Error) => void;
    }> = [];
    const signA = vi.fn(
      () =>
        new Promise<Transaction>((resolve, reject) => {
          deferreds.push({ resolve, reject });
        })
    );
    mocks.holder.signTransaction = signA;

    const { result } = renderHook(() => useRepairWallet());

    // Repair A starts and reaches the signing step.
    let pA!: Promise<void>;
    act(() => {
      pA = result.current.repair([ACCOUNT], true);
    });
    await waitFor(() => expect(signA).toHaveBeenCalledTimes(1));

    // Repair B starts while A is in flight: it must not initiate another
    // signing/submission flow.
    act(() => {
      void result.current.repair([ACCOUNT], true);
    });
    expect(signA).toHaveBeenCalledTimes(1);
    expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();

    // A fails with a user rejection. The lock must be released, and the
    // failure reported.
    await act(async () => {
      deferreds[0].reject(new Error("User rejected the request."));
      await pA;
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("Transaction cancelled");

    // A fresh repair must now run to completion, proving the mutex was
    // released on the failure path too.
    const signC = vi.fn(async (tx: Transaction) => {
      tx.sign(KEYPAIR_A);
      return tx;
    });
    mocks.holder.signTransaction = signC;

    await act(async () => {
      await result.current.repair([ACCOUNT], true);
    });
    expect(result.current.status).toBe("done");
    expect(signC).toHaveBeenCalledTimes(1);
  });

  it("stops and reports the change when the wallet switches mid-repair", async () => {
    const KEYPAIR_B = Keypair.generate();
    const accounts = makeAccounts(21); // two batches: 20 + 1

    let signCalls = 0;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      // Sign with whichever key matches the fee payer. If the repair
      // correctly pins wallet A, this can only ever be KEYPAIR_A.
      const key =
        tx.feePayer && tx.feePayer.equals(KEYPAIR_B.publicKey)
          ? KEYPAIR_B
          : KEYPAIR_A;
      tx.sign(key);
      return tx;
    });

    // Park confirmation so the test controls when batch 1 finishes.
    let releaseConfirm!: (value: { value: { err: null } }) => void;
    const confirmParked = new Promise<{ value: { err: null } }>((resolve) => {
      releaseConfirm = resolve;
    });
    mocks.conn.confirmTransaction.mockReturnValue(confirmParked);

    const { result, rerender } = renderHook(() => useRepairWallet());

    let p!: Promise<void>;
    act(() => {
      p = result.current.repair(accounts, true);
    });
    // Batch 1 is signed and sent; its confirmation is parked.
    await waitFor(() =>
      expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1)
    );

    // The user switches wallets while the run awaits confirmation. The
    // provider hands the next render an updated context value;
    // rerender() commits it - the production mechanism by which a
    // running repair can observe a switch at all (B1: the captured
    // context object itself never changes).
    mocks.holder.publicKey = KEYPAIR_B.publicKey;
    await act(async () => {
      rerender();
    });

    // Batch 1 confirms; the run reaches batch 2's identity check with
    // the committed switch visible and stops before signing again.
    await act(async () => {
      releaseConfirm({ value: { err: null } });
      await p;
    });

    // The run stopped and told the user why, and batch 2 was never built
    // or signed for wallet B.
    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/wallet changed/i);
    expect(signCalls).toBe(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("detects the wallet switch when the adapter issues new context objects (production shape)", async () => {
    // B1 (R4-6). The real wallet provider does NOT mutate a stable
    // context object - it issues a brand-new one on every state change.
    // An in-flight repair closure holds the OLD object, so reading
    // wallet.publicKey from the captured snapshot always showed the
    // original wallet: outside these tests (whose mock mutated in place)
    // the detector compared the original to itself and could never fire.
    // Signing safety was never at risk - the signer is pinned at start,
    // so a run can never sign for the new wallet - but the honest
    // "wallet changed, stopping" message was dead in production. The
    // live public key must reach the running loop through a ref.
    const KEYPAIR_B = Keypair.generate();
    const accounts = makeAccounts(21); // two batches: 20 + 1

    let signCalls = 0;
    const signer = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      tx.sign(KEYPAIR_A);
      return tx;
    });
    mocks.holder.signTransaction = signer;

    // Park confirmation so the test controls when batch 1 finishes.
    let releaseConfirm!: (value: { value: { err: null } }) => void;
    const confirmParked = new Promise<{ value: { err: null } }>((resolve) => {
      releaseConfirm = resolve;
    });
    mocks.conn.confirmTransaction.mockReturnValue(confirmParked);

    const { result, rerender } = renderHook(() => useRepairWallet());

    let p!: Promise<void>;
    act(() => {
      p = result.current.repair(accounts, true);
    });
    await waitFor(() =>
      expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1)
    );

    // The provider replaces the context object while the run awaits
    // confirmation - new object, new publicKey, no in-place mutation of
    // the old one - and React commits it (rerender).
    mocks.holder = {
      publicKey: KEYPAIR_B.publicKey,
      signTransaction: signer,
    };
    await act(async () => {
      rerender();
    });

    await act(async () => {
      releaseConfirm({ value: { err: null } });
      await p;
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/wallet changed/i);
    expect(signCalls).toBe(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("retries with a fresh blockhash when confirmation rejects with the real expiry message", async () => {
    // web3.js 1.98.4 reports a transaction that outlived its blockhash
    // during CONFIRMATION as TransactionExpiredBlockheightExceededError:
    // "Signature <sig> has expired: block height exceeded." The retry
    // used to match only /blockhash/i, which misses this wording, so the
    // automatic fresh-blockhash retry never fired for the most common
    // expiry shape and the user got a dead stop instead of one more
    // approval prompt.
    const EXPIRED = new Error(
      "Signature 5oMNkAGaQ0BsTQ6tCbKWZPaD9q4x5Vp…the signature has expired: block height exceeded."
    );
    let confirmCalls = 0;
    mocks.conn.confirmTransaction.mockImplementation(async () => {
      confirmCalls += 1;
      if (confirmCalls === 1) throw EXPIRED;
      return { value: { err: null } };
    });
    // On the failed first attempt the accounts are genuinely still open.
    mocks.conn.getAccountInfo.mockResolvedValue(STILL_OPEN);

    let signCalls = 0;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair([ACCOUNT], true);
    });

    expect(result.current.status).toBe("done");
    // The user was asked to sign exactly twice: the expired attempt
    // plus the fresh-blockhash retry.
    expect(signCalls).toBe(2);
    expect(confirmCalls).toBe(2);
  });

  it("reports honest partial progress when the final verification itself fails", async () => {
    // R4-2. Two batches (21 accounts -> 20 + 1). Batch 1 confirms and
    // lands. The user rejects batch 2's approval. The catch path then
    // re-verifies on-chain - and THAT RPC call fails too. The report must
    // still be honest about the landed batch: signatures kept, progress
    // reported from the run's confirmed bookkeeping with a verification
    // caveat. Never "Transaction cancelled. Nothing was sent." while a
    // transaction is provably on-chain, and never a crash.
    const accounts = makeAccounts(21);

    let signCalls = 0;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      if (signCalls === 2) {
        throw new Error("User rejected the request.");
      }
      tx.sign(KEYPAIR_A);
      return tx;
    });

    // Batch 1 confirms normally (no verification runs on the success
    // path). The only getAccountInfo caller in this scenario is the
    // catch path's final verification - make it fail.
    mocks.conn.confirmTransaction.mockResolvedValue({ value: { err: null } });
    mocks.conn.getAccountInfo.mockRejectedValue(new Error("RPC unavailable"));

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });

    expect(result.current.status).toBe("error");
    expect(signCalls).toBe(2);
    // The landed batch's receipt is kept, not silently dropped.
    expect(result.current.signatures).toHaveLength(1);
    // Honest progress from the confirmed bookkeeping: 20 of 21 closed,
    // rent sum of batch 1 (every fixture account is 2039280 lamports).
    expect(result.current.closedCount).toBe(20);
    expect(result.current.recoveredLamports).toBe(40785600n);
    expect(result.current.error).toMatch(/stopped after 20 of 21/i);
    expect(result.current.error).not.toMatch(/Nothing was sent/i);
    // The caveat says where the number comes from when the chain could
    // not be asked.
    expect(result.current.error).toMatch(/verification/i);
  });

  it("does not re-sign a confirm-time expiry when the chain already closed the accounts", async () => {
    // The expiry idempotency proof (R4-1). confirmTransaction bounded by
    // lastValidBlockHeight can throw "block height exceeded" in the very
    // instant the transaction landed in one of the final valid blocks: the
    // poll read stale state and gave up, but the chain moved. The retry
    // path must ask the chain FIRST - verifyAccountsClosed - and only
    // rebuild + re-sign a batch the chain still reports open. If that
    // guard ever regresses, the repair would ask the wallet for a second
    // signature to redo work that already happened.
    const EXPIRED = new Error(
      "Signature 5oMNkAGaQ0BsTQ6tCbKWZPaD9q4x5Vp…the signature has expired: block height exceeded."
    );
    mocks.conn.confirmTransaction.mockRejectedValue(EXPIRED);
    // The chain says the account is already closed: the wallet submitted
    // the transaction itself and it landed before the expiry surfaced.
    mocks.conn.getAccountInfo.mockResolvedValue(null);

    let signCalls = 0;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair([ACCOUNT], true);
    });

    // Exactly one signature request: the expiry was recognized as an
    // already-landed repair - never rebuilt, never re-signed, never
    // re-sent.
    expect(signCalls).toBe(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.conn.getLatestBlockhash).toHaveBeenCalledTimes(1);
    // The run reports full success, not the friendly-expired dead stop.
    expect(result.current.status).toBe("done");
    expect(result.current.closedCount).toBe(1);
    expect(result.current.recoveredLamports).toBe(2039280n);
    expect(result.current.signatures).toHaveLength(1);
  });

  it("reports the friendly expired message when both attempts expire", async () => {
    const EXPIRED = new Error(
      "Signature 5oMNkAGaQ0BsTQ6tCbKWZPaD9q4x5Vp…the signature has expired: block height exceeded."
    );
    mocks.conn.confirmTransaction.mockRejectedValue(EXPIRED);
    mocks.conn.getAccountInfo.mockResolvedValue(STILL_OPEN);

    let signCalls = 0;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair([ACCOUNT], true);
    });

    expect(result.current.status).toBe("error");
    // The friendly copy, not the raw library message.
    expect(result.current.error).toMatch(
      /expired while waiting for approval/i
    );
    expect(result.current.error).not.toMatch(/Signature 5oMN/i);
    // Both attempts were used before giving up.
    expect(signCalls).toBe(2);
  });
});
