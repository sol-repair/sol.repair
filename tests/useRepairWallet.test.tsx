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
  SystemProgram,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  MAX_ACCOUNTS_PER_RUN,
  useRepairWallet,
} from "../src/hooks/useRepairWallet";
import { heldAction } from "../src/lib/actionMutex";
import { MAX_CLOSE_INSTRUCTIONS_PER_TX } from "../src/lib/solana/transactions";
import {
  TOKEN_2022_PROGRAM_ID,
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
    getMultipleAccountsInfo: vi.fn(),
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    getSignatureStatuses: vi.fn(),
    getBlockHeight: vi.fn(),
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
// open, owned by the classic token program. The lamports figure is
// load-bearing since the fresh-read gate: it is the fee base, so an open
// fixture account holds the same 2,039,280 the scan recorded (a real
// token account cannot exist at zero lamports).
const STILL_OPEN = {
  lamports: 2039280,
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

// A deterministic account carrying the SCAN's lamports figure.
function accountAt(seed: number, lamports: number): ClosableAccount {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return {
    pubkey: new PublicKey(bytes).toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    lamports,
    program: "spl",
  };
}

// A token account still open on-chain, holding the given lamports - the
// figure a fresh read returns, and the fee base since the gate read exists.
const openAt = (lamports: number) => ({ ...STILL_OPEN, lamports });

describe("useRepairWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.holder.publicKey = KEYPAIR_A.publicKey;
    mocks.conn.getLatestBlockhash.mockResolvedValue({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1000,
    });
    mocks.conn.sendRawTransaction.mockResolvedValue("signed-tx-id");
    // Confirmation is HTTP-polled (getSignatureStatuses); the default mock
    // answers "confirmed" on the first poll, below the blockhash expiry
    // height, so the ordinary path never loops.
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [{ err: null, confirmationStatus: "confirmed" }],
    });
    mocks.conn.getBlockHeight.mockResolvedValue(990);
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => STILL_OPEN)
    );
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

  it("appends the fee transfer as the final instruction of the signed transaction", async () => {
    // The 1% service fee rides AFTER the closes so the rent they return
    // inside the same atomic transaction can cover it - a wallet holding
    // no spare SOL must still be able to pay the service fee (fees.ts).
    // The ordering is load-bearing, not cosmetic, so it is pinned here
    // (audit 2026-09-29, finding F4): every instruction before the last
    // is a token-program instruction, and the System transfer is last.
    const accounts = makeAccounts(2);
    const seenInstructions: TransactionInstruction[][] = [];
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      seenInstructions.push(tx.instructions);
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });
    expect(result.current.status).toBe("done");

    expect(seenInstructions).toHaveLength(1);
    const ixs = seenInstructions[0];
    // Both accounts are clean (no delegate), so everything before the fee
    // is a closeAccount against one of the two token programs.
    expect(ixs).toHaveLength(3);
    for (const ix of ixs.slice(0, -1)) {
      expect(
        ix.programId.equals(TOKEN_PROGRAM_ID) ||
          ix.programId.equals(TOKEN_2022_PROGRAM_ID)
      ).toBe(true);
    }
    const fee = ixs[ixs.length - 1];
    expect(fee.programId.equals(SystemProgram.programId)).toBe(true);
    // floor(1% of 2 x 2,039,280) = 40,785 lamports, u64 LE at offset 4.
    expect(fee.data.readBigUInt64LE(4)).toBe(40785n);
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

    // Park confirmation polling so the test controls when batch 1 finishes.
    let releaseConfirm!: (value: {
      value: Array<{ err: null; confirmationStatus: string }>;
    }) => void;
    const confirmParked = new Promise<{
      value: Array<{ err: null; confirmationStatus: string }>;
    }>((resolve) => {
      releaseConfirm = resolve;
    });
    mocks.conn.getSignatureStatuses.mockReturnValue(confirmParked);

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
      releaseConfirm({
        value: [{ err: null, confirmationStatus: "confirmed" }],
      });
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

    // Park confirmation polling so the test controls when batch 1 finishes.
    let releaseConfirm!: (value: {
      value: Array<{ err: null; confirmationStatus: string }>;
    }) => void;
    const confirmParked = new Promise<{
      value: Array<{ err: null; confirmationStatus: string }>;
    }>((resolve) => {
      releaseConfirm = resolve;
    });
    mocks.conn.getSignatureStatuses.mockReturnValue(confirmParked);

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
      releaseConfirm({
        value: [{ err: null, confirmationStatus: "confirmed" }],
      });
      await p;
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/wallet changed/i);
    expect(signCalls).toBe(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("retries with a fresh blockhash when the poll reports expiry", async () => {
    // A transaction that outlives its blockhash during confirmation must
    // surface as an expiry-shaped error so the automatic fresh-blockhash
    // retry fires; matching only one library's wording historically left
    // the most common expiry shape a dead stop instead of one more
    // approval prompt.
    // Poll 1 sees no status while the blockhash expires, so the bounded
    // poll throws the expiry-shaped error and the retry machinery treats
    // it exactly as the web3.js confirmation path did. Poll 2, on the
    // fresh blockhash, confirms.
    let pollCalls = 0;
    mocks.conn.getSignatureStatuses.mockImplementation(async () => {
      pollCalls += 1;
      if (pollCalls === 1) return { value: [null] };
      return { value: [{ err: null, confirmationStatus: "confirmed" }] };
    });
    mocks.conn.getBlockHeight.mockResolvedValue(1001);
    // On the failed first attempt the accounts are genuinely still open.
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => STILL_OPEN)
    );

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
    expect(pollCalls).toBe(2);
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
    // path). getMultipleAccountsInfo is called for each batch's
    // fresh-read gate and then twice for batch 2: the attempt-level
    // verification and the catch path's final one. Both gates answer
    // (the batches can be built); from the first verification on the
    // RPC is down, so BOTH reads fail - as they did before the gate
    // existed, when every call rejected.
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [{ err: null, confirmationStatus: "confirmed" }],
    });
    let reads = 0;
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => {
        reads += 1;
        if (reads >= 3) throw new Error("RPC unavailable");
        return pks.map(() => STILL_OPEN);
      }
    );

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
    // The expiry idempotency proof (R4-1). The bounded confirmation poll can
    // throw "block height exceeded" in the very
    // instant the transaction landed in one of the final valid blocks: the
    // poll read stale state and gave up, but the chain moved. The retry
    // path must ask the chain FIRST - verifyAccountsClosed - and only
    // rebuild + re-sign a batch the chain still reports open. If that
    // guard ever regresses, the repair would ask the wallet for a second
    // signature to redo work that already happened.
    // The poll never finds a status and the blockhash height passes: the
    // bounded poll throws the expiry-shaped error, exactly as web3.js's
    // bounded confirmation did.
    mocks.conn.getSignatureStatuses.mockResolvedValue({ value: [null] });
    mocks.conn.getBlockHeight.mockResolvedValue(1001);
    // The chain says the account is already closed: the wallet submitted
    // the transaction itself and it landed before the expiry surfaced.
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => null)
    );

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

  it("treats a confirmation that resolves with an on-chain error as a failure", async () => {
    // A confirmation poll can observe the transaction landed WITH an
    // on-chain error: status.err set at confirmed commitment. A
    // landed-and-failed transaction is atomic - nothing closed, nothing
    // moved - and must never be booked as a landed repair with success
    // copy.
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [
        {
          err: { InstructionError: [0, { Custom: 311 }] },
          confirmationStatus: "confirmed",
        },
      ],
    });
    // The accounts are genuinely still open (the transaction failed).
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => STILL_OPEN)
    );

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
    expect(signCalls).toBe(1);
    expect(result.current.closedCount).toBe(0);
    expect(result.current.recoveredLamports).toBe(0n);
    expect(result.current.error).toMatch(/failed/i);
    // Not the expiry copy: this is a distinct, honest failure mode.
    expect(result.current.error).not.toMatch(/expired while waiting/i);
  });

  it("retries with a fresh blockhash when the wallet refuses a stale transaction", async () => {
    // Live-observed shape (Sep 14 devnet): Phantom simulates the
    // transaction BEFORE showing the prompt, and on a hot cluster that
    // simulation can outlive the blockhash window - the adapter then
    // rejects signing with an expiry-shaped error and no prompt ever
    // showed. That refusal must feed the same fresh-blockhash retry as
    // a failed send, not dead-stop the repair after zero prompts.
    let signCalls = 0;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      if (signCalls === 1) {
        throw new Error("Transaction expired");
      }
      tx.sign(KEYPAIR_A);
      return tx;
    });
    // The chain says the accounts are genuinely still open.
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => STILL_OPEN)
    );

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair([ACCOUNT], true);
    });

    // The refusal was retried with a fresh blockhash and landed.
    expect(result.current.status).toBe("done");
    expect(signCalls).toBe(2);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.conn.getLatestBlockhash).toHaveBeenCalledTimes(2);
  });

  it("reports the friendly expired message when both attempts expire", async () => {
    // The poll never finds a status and the blockhash height passes: the
    // bounded poll throws the expiry-shaped error, exactly as web3.js's
    // bounded confirmation did.
    mocks.conn.getSignatureStatuses.mockResolvedValue({ value: [null] });
    mocks.conn.getBlockHeight.mockResolvedValue(1001);
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => STILL_OPEN)
    );

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
    // The why in plain words: a user who is told only that it expired
    // thinks the site is broken.
    expect(result.current.error).toMatch(
      /network moved on while the wallet window was open/i
    );
    expect(result.current.error).not.toMatch(/Signature 5oMN/i);
    // Both attempts were used before giving up.
    expect(signCalls).toBe(2);
  });

  it("keeps raw library errors out of the error line, moving them to errorDetail", async () => {
    // Live-observed shape (Sep 8 mid-flight scenario): the send is
    // refused with a raw SendTransactionError whose text ends with
    // instructions written for developers. The main error line must be
    // plain words; the raw text moves to errorDetail for the
    // collapsible detail view instead of being dumped on the user.
    const RAW = new Error(
      "SendTransactionError: failed to send transaction: Transaction simulation failed: Error: Non-native account can only be closed if its balance is zero. Catch the `SendTransactionError` and call `getLogs()` on it for full details."
    );
    mocks.conn.sendRawTransaction.mockRejectedValue(RAW);
    // The accounts are genuinely still open (the send never landed).
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => STILL_OPEN)
    );

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
    expect(result.current.error).toBe(
      "The repair transaction did not go through. No accounts were closed when we checked the chain. Solana transactions are atomic, so nothing half-landed. Dismiss to refresh the scan, then run the repair again if accounts are still open."
    );
    // The raw text is preserved, not hidden.
    expect(result.current.errorDetail).toMatch(/SendTransactionError/);
    expect(result.current.errorDetail).toMatch(/getLogs/);
    // The user-facing line carries none of it.
    expect(result.current.error).not.toMatch(/getLogs/);
    expect(signCalls).toBe(1);
  });

  it("retries only the still-open accounts after externally-partial closes", async () => {
    // External-audit 2026-09-02 hardening spec: a transaction is ATOMIC,
    // so verification reading 7-closed/13-open of a 20-account batch
    // means something else closed those 7 mid-run. The expiry retry must
    // be RECONCILED with that verification: rebuild from the 13
    // still-open accounts, fee recalculated on the retry batch only,
    // second transaction lands, run completes 20-for-20. A stale
    // full-batch retry can never land (closing nonexistent accounts
    // fails the whole transaction), so the owner would get a doomed
    // approval instead of a finished repair.
    const accounts = makeAccounts(20); // one batch of 20

    // 7 of the 20 were closed by something else mid-run.
    const closedElsewhere = new Set(accounts.slice(0, 7).map((a) => a.pubkey));
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) =>
        pks.map((pk) =>
          closedElsewhere.has(pk.toBase58()) ? null : STILL_OPEN
        )
    );

    let pollCalls = 0;
    mocks.conn.getSignatureStatuses.mockImplementation(async () => {
      pollCalls += 1;
      if (pollCalls === 1) {
        // No status yet; the height check then throws the expiry error.
        return { value: [null] };
      }
      // The reconciled 13-account retry lands cleanly.
      return { value: [{ err: null, confirmationStatus: "confirmed" }] };
    });
    mocks.conn.getBlockHeight.mockResolvedValue(1001);

    // Capture what each approval actually contained: close count and the
    // fee transfer lamports. In this web3.js build the System transfer's
    // from/to ride in the account metas, so the data is just the u32
    // instruction tag plus the u64 LE lamports at offset 4.
    const approvals: Array<{ closes: number; feeLamports: bigint | null }> = [];
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      // CloseAccount is token instruction tag 9 in both token programs;
      // counting by data tag cannot mistake a Revoke (tag 5) for a close.
      const closes = tx.instructions.filter(
        (ix) => ix.data.length === 1 && ix.data[0] === 9
      ).length;
      const feeIx = tx.instructions.find(
        (ix) => ix.programId.toBase58() === SystemProgram.programId.toBase58()
      );
      approvals.push({
        closes,
        feeLamports: feeIx ? feeIx.data.readBigUInt64LE(4) : null,
      });
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });

    // Approval 1: the original full batch with the full-batch fee.
    expect(approvals[0].closes).toBe(MAX_CLOSE_INSTRUCTIONS_PER_TX);
    expect(approvals[0].feeLamports).toBe(407856n); // floor(20 x 2039280 / 100)
    // Approval 2: RECONCILED - the 13 still-open accounts only, with the
    // fee recalculated on the retry batch only.
    expect(approvals).toHaveLength(2);
    expect(approvals[1].closes).toBe(13);
    expect(approvals[1].feeLamports).toBe(265106n); // floor(13 x 2039280 / 100)
    // The retry landed: the run completes with everything closed and the
    // recovered amount covering all 20 accounts' rent.
    expect(result.current.status).toBe("done");
    expect(result.current.closedCount).toBe(20);
    expect(result.current.recoveredLamports).toBe(20n * 2039280n);
    expect(pollCalls).toBe(2);
  });

  it("still reports honestly when the reconciled retry also fails", async () => {
    // The safety net the hardened path must keep (owner instruction:
    // do not weaken the honest-failure proof): if the reconciled retry
    // ALSO fails (non-retryable), the run stops with the honest partial
    // report derived from verified chain state - never a false success,
    // never a masked failure.
    const accounts = makeAccounts(20);

    const closedElsewhere = new Set(accounts.slice(0, 7).map((a) => a.pubkey));
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) =>
        pks.map((pk) =>
          closedElsewhere.has(pk.toBase58()) ? null : STILL_OPEN
        )
    );

    let pollCalls = 0;
    let lastCloses = 0;
    mocks.conn.getSignatureStatuses.mockImplementation(async () => {
      pollCalls += 1;
      if (pollCalls === 1) {
        // No status yet; the height check then throws the expiry error.
        return { value: [null] };
      }
      // The reconciled retry's confirmation query itself fails with a
      // non-expiry error: not retryable, not a landed failure.
      throw new Error(
        "Transaction 62hkW… failed: TransactionExecutionError: InstructionError { Custom: 3 }"
      );
    });
    mocks.conn.getBlockHeight.mockResolvedValue(1001);
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      lastCloses = tx.instructions.filter((ix) =>
        ix.programId.toBase58().startsWith("Token")
      ).length;
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });

    // The second approval was the reconciled 13-account retry, and it
    // failed on-chain: honest partial report, exact numbers, receipt kept.
    expect(lastCloses).toBe(13);
    expect(result.current.status).toBe("error");
    expect(result.current.closedCount).toBe(7);
    expect(result.current.recoveredLamports).toBe(7n * 2039280n);
    expect(result.current.error).toMatch(/stopped after 7 of 20/);
  });

  it("caps a run at MAX_ACCOUNTS_PER_RUN accounts and leaves the rest for the next run", async () => {
    // The repair ceiling: one run covers at most 100 accounts - five
    // approval popups of 20 closes each. A 250-account selection must
    // stop at 100, and the 101st account must never appear in any signed
    // transaction. The remaining 150 are closed by running the repair
    // again, not by 13 popups in one sitting.
    const accounts = makeAccounts(250);

    const approvals: Array<{ closes: number; closedKeys: string[] }> = [];
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      const closeIxs = tx.instructions.filter(
        (ix) => ix.data.length === 1 && ix.data[0] === 9
      );
      approvals.push({
        closes: closeIxs.length,
        closedKeys: closeIxs.map((ix) => ix.keys[0].pubkey.toBase58()),
      });
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });

    // Exactly five approvals, each the full 20 closes.
    expect(result.current.status).toBe("done");
    expect(approvals).toHaveLength(
      MAX_ACCOUNTS_PER_RUN / MAX_CLOSE_INSTRUCTIONS_PER_TX
    );
    for (const approval of approvals) {
      expect(approval.closes).toBe(MAX_CLOSE_INSTRUCTIONS_PER_TX);
    }
    // The first 100 accounts, in order, and nothing beyond them.
    const closedKeys = approvals.flatMap((a) => a.closedKeys);
    expect(new Set(closedKeys).size).toBe(MAX_ACCOUNTS_PER_RUN);
    expect(closedKeys).toContain(accounts[0].pubkey);
    expect(closedKeys).toContain(accounts[MAX_ACCOUNTS_PER_RUN - 1].pubkey);
    expect(closedKeys).not.toContain(accounts[MAX_ACCOUNTS_PER_RUN].pubkey);
    expect(closedKeys).not.toContain(accounts[249].pubkey);
    // The bookkeeping covers the run, not the whole selection.
    expect(result.current.totalToClose).toBe(MAX_ACCOUNTS_PER_RUN);
    expect(result.current.closedCount).toBe(MAX_ACCOUNTS_PER_RUN);
    expect(result.current.recoveredLamports).toBe(
      BigInt(MAX_ACCOUNTS_PER_RUN) * 2039280n
    );
  });

  it("reconciles and retries when an on-chain failure leaves part of the batch already closed", async () => {
    // A stale scan: the run's first transaction contains an account that
    // something else closed before the run started. The CloseAccount on
    // a nonexistent account fails the WHOLE transaction on-chain - and
    // under error-classification-by-message-shape that dead-stopped the
    // run with a wasted approval. An on-chain failure is atomic (the
    // transaction closed nothing itself), so a proper-subset closure is
    // external evidence, exactly like the expiry path's reconciliation:
    // rebuild from the accounts the chain still reports open,
    // recalculate the fee on the retry batch, and ask for one more
    // approval.
    const accounts = makeAccounts(20); // one batch of 20
    const stale = accounts[0].pubkey;
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) =>
        pks.map((pk) => (pk.toBase58() === stale ? null : STILL_OPEN))
    );
    let pollCalls = 0;
    mocks.conn.getSignatureStatuses.mockImplementation(async () => {
      pollCalls += 1;
      if (pollCalls === 1) {
        // The transaction lands WITH an on-chain error: the stale
        // account's close fails the whole atomic transaction.
        return {
          value: [
            {
              err: { InstructionError: [0, { Custom: 311 }] },
              confirmationStatus: "confirmed",
            },
          ],
        };
      }
      // The reconciled 19-account retry lands cleanly.
      return { value: [{ err: null, confirmationStatus: "confirmed" }] };
    });

    const approvals: Array<{ closes: number; feeLamports: bigint | null }> = [];
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      const closes = tx.instructions.filter(
        (ix) => ix.data.length === 1 && ix.data[0] === 9
      ).length;
      const feeIx = tx.instructions.find(
        (ix) => ix.programId.toBase58() === SystemProgram.programId.toBase58()
      );
      approvals.push({
        closes,
        feeLamports: feeIx ? feeIx.data.readBigUInt64LE(4) : null,
      });
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });

    // Approval 2 is the reconciled retry: the 19 still-open accounts
    // only, with the fee recalculated on the retry batch only.
    expect(approvals).toHaveLength(2);
    expect(approvals[0].closes).toBe(20);
    expect(approvals[0].feeLamports).toBe(407856n); // floor(20 x 2039280 / 100)
    expect(approvals[1].closes).toBe(19);
    expect(approvals[1].feeLamports).toBe(387463n); // floor(19 x 2039280 / 100)
    // The retry landed; the run reports every account in its slice closed.
    expect(result.current.status).toBe("done");
    expect(result.current.closedCount).toBe(20);
    expect(result.current.recoveredLamports).toBe(20n * 2039280n);
    expect(pollCalls).toBe(2);
  });

  it("does not retry an on-chain failure when nothing in the batch closed", async () => {
    // The other half of the reconcile rule, pinned so it cannot be
    // broadened blindly: a subset closure is external evidence and
    // justifies one rebuilt retry; with NOTHING closed the failure cause
    // is still inside the batch (frozen account, foreign authority,
    // program error), so the identical batch would fail the same way
    // again. The run stops with the honest on-chain-failure report
    // instead of spending a second approval on a doomed retry.
    const accounts = makeAccounts(20);
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => STILL_OPEN)
    );
    mocks.conn.getSignatureStatuses.mockResolvedValue({
      value: [
        {
          err: { InstructionError: [0, { Custom: 311 }] },
          confirmationStatus: "confirmed",
        },
      ],
    });

    let signCalls = 0;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });

    expect(result.current.status).toBe("error");
    expect(signCalls).toBe(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.current.closedCount).toBe(0);
    expect(result.current.recoveredLamports).toBe(0n);
    expect(result.current.error).toMatch(/confirmed on-chain but failed/);
  });

  it("does not credit accounts from batches it never attempted", async () => {
    // The two-truths defect: the error path re-read the ENTIRE run
    // slice and REPLACED the confirmed bookkeeping with that read. A
    // pre-existing closure in a batch the run never reached was
    // reported as this run's progress, and landed batches were erased
    // behind the same stale chain view. Here batch 1 lands (a receipt
    // on chain), the user rejects batch 2's approval, and batch 3's
    // stale account was closed before the run ever started - a batch
    // the run never attempted. The honest report is 20 of 42 - the
    // landed batch - never 1 of 42, and never 21 with the unattempted
    // batch's closure folded in.
    const accounts = makeAccounts(42); // batches: 20 + 20 + 2
    const stale = accounts[41].pubkey; // batch 3: never attempted
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) =>
        pks.map((pk) => (pk.toBase58() === stale ? null : STILL_OPEN))
    );

    let signCalls = 0;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      if (signCalls === 2) {
        throw new Error("User rejected the request.");
      }
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });

    expect(result.current.status).toBe("error");
    expect(signCalls).toBe(2);
    // Batch 1's receipt is kept AND its progress is counted.
    expect(result.current.signatures).toHaveLength(1);
    expect(result.current.closedCount).toBe(20);
    expect(result.current.recoveredLamports).toBe(20n * 2039280n);
    expect(result.current.error).toMatch(/stopped after 20 of 42/);
    expect(result.current.error).toMatch(/You cancelled the remaining approvals/);
  });

  it("credits a last batch that landed unseen, and keeps the landed batches behind it", async () => {
    // The self-submission race at the outer catch: batch 1 lands
    // normally; batch 2's send is rejected (the wallet submitted the
    // signed transaction itself), and the attempt-level verification
    // runs while the RPC is down. When the outer catch's read recovers,
    // the chain shows batch 2's account closed. The report must carry
    // BOTH batches - 21 of 21 - instead of the whole-slice read's
    // stale answer replacing the confirmed bookkeeping with whatever
    // that single read happened to see.
    const accounts = makeAccounts(21); // batches: 20 + 1
    let sendCalls = 0;
    mocks.conn.sendRawTransaction.mockImplementation(async () => {
      sendCalls += 1;
      // Batch 2's send only: the wallet submitted the signed transaction
      // itself, so our own submission is rejected.
      if (sendCalls === 2) throw new Error("already submitted");
      return "signed-tx-id";
    });
    let verifyCalls = 0;
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => {
        verifyCalls += 1;
        // Reads 1 and 2 are the two batches' fresh-read gates. Read 3 is
        // the attempt-level verification, which runs while the RPC is
        // down. Read 4 is the outer catch's, after the RPC recovers.
        if (verifyCalls === 3) throw new Error("RPC unavailable");
        return pks.map((pk) =>
          pk.toBase58() === accounts[20].pubkey ? null : STILL_OPEN
        );
      }
    );

    let signCalls = 0;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });

    expect(result.current.status).toBe("error");
    expect(signCalls).toBe(2);
    // Batch 1's confirmed receipt AND batch 2's verified landing.
    expect(result.current.signatures).toHaveLength(1);
    expect(result.current.closedCount).toBe(21);
    expect(result.current.recoveredLamports).toBe(21n * 2039280n);
    expect(result.current.error).toMatch(/stopped after 21 of 21/);
  });

  /* ------------------------------------------------------------------ */
  /* The fresh-read fee base (whole-repository audit 2026-11-24,         */
  /* finding 1). The classic repair built its 1% fee and its recovered   */
  /* figure from the SCAN's lamports. The dust flow was fixed for the    */
  /* same defect in b9e0c40 (its fee base became the gate read's         */
  /* lamports); these pin the classic flow to that standard.             */
  /* Calibration: the fee ledger's mainnet history shows zero fee        */
  /* violations ever - the gap was latent, never seen on a live row.     */
  /* ------------------------------------------------------------------ */

  it("charges the fee and reports recovery from the gate-time lamports, never the scan's", async () => {
    // The scan saw both accounts at one figure; the chain moved before
    // the run. A top-up landed on one (+1,000,000) and 988,440 lamports
    // left the other. The close returns what each account holds NOW, so
    // the 1% fee and the recovered figure must be built from a fresh
    // read: an under- or overcharged fee and a recovered figure the
    // wallet's own balance contradicts are the same defect.
    const toppedUp = accountAt(1, 1488440);
    const reduced = accountAt(2, 2488440);
    const gate = new Map<string, number>([
      [toppedUp.pubkey, 2488440],
      [reduced.pubkey, 1500000],
    ]);
    const events: string[] = [];
    const held: Array<string | null> = [];
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => {
        events.push("read");
        held.push(heldAction());
        return pks.map((pk) => openAt(gate.get(pk.toBase58()) ?? -1));
      }
    );
    let feeLamports: bigint | null = null;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      events.push("sign");
      const last = tx.instructions[tx.instructions.length - 1];
      feeLamports = last.programId.equals(SystemProgram.programId)
        ? last.data.readBigUInt64LE(4)
        : null;
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair([toppedUp, reduced], true);
    });

    expect(result.current.status).toBe("done");
    // floor(1% of 2,488,440 + 1,500,000 = 3,988,440) = 39,884. The
    // scan's figures would have charged floor(1% of 3,976,880) = 39,768.
    expect(feeLamports).toBe(39884n);
    // The recovered figure is the same fresh sum, not the scan's 3,976,880.
    expect(result.current.recoveredLamports).toBe(3988440n);
    expect(result.current.closedCount).toBe(2);
    // The read happened BEFORE the wallet was asked to sign, and under
    // the action lock (the dust flow's in-lock gate discipline).
    expect(events[0]).toBe("read");
    expect(events.indexOf("read")).toBeLessThan(events.indexOf("sign"));
    expect(held).toEqual(["repair"]);
    // At confirmed commitment: the view the repair's confirmation
    // waits on, the same one verification reads at.
    expect(mocks.conn.getMultipleAccountsInfo).toHaveBeenCalledWith(
      expect.any(Array),
      "confirmed"
    );
  });

  it("recalculates a reconciled retry's fee from a fresh read at retry time", async () => {
    // Approval 1 expires while the user sits on the popup, and a top-up
    // lands on one still-open account in the meantime. The rebuilt retry
    // closes the 13 accounts the chain still reports open - and its fee
    // must be floor(1%) of what THOSE hold when the retry is built, not
    // the scan's stale figures.
    const accounts = Array.from({ length: 20 }, (_, i) =>
      accountAt(10 + i, 2039280)
    );
    const lateTopUp = accounts[7].pubkey;
    // Chain state, content-addressed (never call-order): 7 accounts were
    // closed by something else before the run; the rest are open at the
    // scan figure.
    const chain = new Map<string, number | null>(
      accounts.map((a, i) => [a.pubkey, i < 7 ? null : 2039280])
    );
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) =>
        pks.map((pk) => {
          const lamports = chain.get(pk.toBase58()) ?? null;
          return lamports === null ? null : openAt(lamports);
        })
    );
    let signCalls = 0;
    const approvals: Array<{ closes: number; feeLamports: bigint | null }> =
      [];
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      const closes = tx.instructions.filter(
        (ix) => ix.data.length === 1 && ix.data[0] === 9
      ).length;
      const feeIx = tx.instructions.find((ix) =>
        ix.programId.equals(SystemProgram.programId)
      );
      approvals.push({
        closes,
        feeLamports: feeIx ? feeIx.data.readBigUInt64LE(4) : null,
      });
      // The top-up lands while the first approval popup is open.
      if (signCalls === 1) chain.set(lateTopUp, 3039280);
      tx.sign(KEYPAIR_A);
      return tx;
    });
    let pollCalls = 0;
    mocks.conn.getSignatureStatuses.mockImplementation(async () => {
      pollCalls += 1;
      if (pollCalls === 1) return { value: [null] };
      return { value: [{ err: null, confirmationStatus: "confirmed" }] };
    });
    mocks.conn.getBlockHeight.mockResolvedValue(1001);

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });

    expect(result.current.status).toBe("done");
    expect(approvals).toHaveLength(2);
    // Approval 1 was built before the top-up existed.
    expect(approvals[0].closes).toBe(20);
    expect(approvals[0].feeLamports).toBe(407856n); // floor(20 x 2,039,280 / 100)
    // Approval 2: floor(1% of 12 x 2,039,280 + 3,039,280 = 27,510,640)
    // = 275,106. The scan's figures would have charged 265,106.
    expect(approvals[1].closes).toBe(13);
    expect(approvals[1].feeLamports).toBe(275106n);
    // 19 accounts at the scan figure, plus the topped-up one.
    expect(result.current.recoveredLamports).toBe(19n * 2039280n + 3039280n);
  });

  const unreadableGate: Array<
    [string, () => Promise<unknown>, string | null]
  > = [
    [
      "the RPC rejects the read",
      () => Promise.reject(new Error("HTTP 429 after retries")),
      // The transport error's own text is kept, as the detail.
      "HTTP 429 after retries",
    ],
    ["the response is shorter than the request", () => Promise.resolve([]), null],
    [
      "a lamports figure is not a whole number",
      () => Promise.resolve([{ ...STILL_OPEN, lamports: "2039280" }]),
      null,
    ],
  ];

  it.each(unreadableGate)(
    "stops before signing when the current balances cannot be read: %s",
    async (_label, respond, rawDetail) => {
      // A fee base the run could not read is never replaced by the
      // scan's figure: that is the stale-base defect wearing a fallback's
      // clothes. Nothing is built, so nothing reaches the wallet.
      mocks.conn.getMultipleAccountsInfo.mockImplementation(respond);
      const signer = vi.fn(async (tx: Transaction) => {
        tx.sign(KEYPAIR_A);
        return tx;
      });
      mocks.holder.signTransaction = signer;

      const { result } = renderHook(() => useRepairWallet());

      await act(async () => {
        await result.current.repair([ACCOUNT], true);
      });

      expect(signer).not.toHaveBeenCalled();
      expect(mocks.conn.getLatestBlockhash).not.toHaveBeenCalled();
      expect(mocks.conn.sendRawTransaction).not.toHaveBeenCalled();
      expect(result.current.status).toBe("error");
      expect(result.current.closedCount).toBe(0);
      expect(result.current.recoveredLamports).toBe(0n);
      expect(result.current.error).toMatch(/could not be read/);
      // Raw RPC text stays out of the main line (FriendlyError copy) and
      // is preserved, not hidden, in the collapsed detail.
      expect(result.current.error).not.toMatch(/HTTP 429/);
      expect(result.current.errorDetail).toBe(rawDetail);
    }
  );

  it("reports landed batches honestly when a later batch's balances cannot be read", async () => {
    // Batch 1 (20 accounts) lands. Batch 2's read fails: the run must
    // stop BEFORE building it, and say so without claiming nothing was
    // sent - batch 1 provably was, and its progress stands.
    const accounts = makeAccounts(21); // batches: 20 + 1
    let reads = 0;
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => {
        reads += 1;
        // Read 1: batch 1's gate. Read 2: batch 2's gate - unreadable.
        // Read 3: the outer catch's scoped re-verification of batch 2.
        if (reads === 2) throw new Error("HTTP 429 after retries");
        return pks.map(() => openAt(2039280));
      }
    );
    let signCalls = 0;
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      signCalls += 1;
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair(accounts, true);
    });

    expect(result.current.status).toBe("error");
    expect(signCalls).toBe(1);
    expect(mocks.conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.current.signatures).toHaveLength(1);
    expect(result.current.closedCount).toBe(20);
    expect(result.current.recoveredLamports).toBe(20n * 2039280n);
    expect(result.current.error).toMatch(/stopped after 20 of 21/);
    expect(result.current.error).toMatch(/could not be read/);
    expect(result.current.error).not.toMatch(/Nothing was sent/);
  });
});

/* ------------------------------------------------------------------ */
/* The Token-2022 post-scan race hint on the failure terminals         */
/* (audit M1-C, 2026-10)                                               */
/* ------------------------------------------------------------------ */

const T22_ACCOUNT: ClosableAccount = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  lamports: 2039280,
  program: "token-2022",
};

const TOKEN22_HINT =
  " If the failed batch included a Token-2022 account, it may hold an extension balance the token program refuses to close. A fresh scan lists such accounts as skipped with the reason, and the repair can then close the rest.";

describe("useRepairWallet Token-2022 failure hint", () => {
  it("appends the extension hint to the nothing-closed failure when the batch has a Token-2022 account", async () => {
    const RAW = new Error(
      "SendTransactionError: failed to send transaction: Transaction simulation failed: Error: Account found, but not closed. Catch the `SendTransactionError` and call `getLogs()` on it for full details."
    );
    mocks.conn.sendRawTransaction.mockRejectedValue(RAW);
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => STILL_OPEN)
    );
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair([T22_ACCOUNT], true);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe(
      "The repair transaction did not go through. No accounts were closed when we checked the chain. Solana transactions are atomic, so nothing half-landed. Dismiss to refresh the scan, then run the repair again if accounts are still open." +
        TOKEN22_HINT
    );
    // The raw library text still moves to errorDetail.
    expect(result.current.errorDetail).toMatch(/SendTransactionError/);
  });

  it("keeps the classic-batch failure copy unchanged, with no hint", async () => {
    const RAW = new Error("SendTransactionError: failed to send transaction");
    mocks.conn.sendRawTransaction.mockRejectedValue(RAW);
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => STILL_OPEN)
    );
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair([ACCOUNT], true);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).not.toMatch(/Token-2022 account/);
    expect(result.current.error).not.toMatch(/extension balance/);
  });

  it("appends the rescan hint to the partial-failure copy when the failed batch has a Token-2022 account", async () => {
    // Batch one (20 classic accounts) lands; batch two (one Token-2022
    // account) fails with nothing closed, so the run stops partial.
    const classics = Array.from({ length: 20 }, () => ({
      ...ACCOUNT,
      pubkey: Keypair.generate().publicKey.toBase58(),
      mint: Keypair.generate().publicKey.toBase58(),
    }));
    let sendCalls = 0;
    mocks.conn.sendRawTransaction.mockImplementation(async () => {
      sendCalls += 1;
      if (sendCalls === 1) return "batch-one-sig";
      throw new Error("SendTransactionError: failed to send transaction");
    });
    mocks.conn.getMultipleAccountsInfo.mockImplementation(
      async (pks: PublicKey[]) => pks.map(() => STILL_OPEN)
    );
    mocks.holder.signTransaction = vi.fn(async (tx: Transaction) => {
      tx.sign(KEYPAIR_A);
      return tx;
    });

    const { result } = renderHook(() => useRepairWallet());

    await act(async () => {
      await result.current.repair([...classics, T22_ACCOUNT], true);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(
      /Repair stopped after 20 of 21 accounts were closed/
    );
    expect(result.current.error).toMatch(
      /0\.040786 SOL recovered/
    );
    expect(result.current.error).toContain(TOKEN22_HINT);
  });
});
