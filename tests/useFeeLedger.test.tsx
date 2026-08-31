// @vitest-environment jsdom

/**
 * Stale-response tests for useFeeLedger's loadMore.
 *
 * The initial fetch is protected by a generation counter: a response
 * from an abandoned cluster/reload may never write state. loadMore had
 * no such guard, so a "Load 25 more" started on one cluster could
 * resolve after a cluster switch and stamp the old cluster's rows and
 * cursor into the new view. Only the RPC boundary (global fetch) is
 * mocked; the hook and the ledger extraction layer are the real ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { TOKEN_PROGRAM_ID } from "../src/lib/solana/tokenAccounts";
import { useFeeLedger } from "../src/hooks/useFeeLedger";

const MAINNET_WALLET = "6qhajWTtUKadkMaumpADGBkmPkASiwXRqGtqd8ypL74K";
const DEVNET_WALLET = "4Z5iVtvydRcrMJdRbrXSpn3vhrxzLE8hZGnzm6ejMKpn";
const RECENT_BLOCKHASH = PublicKey.default.toBase58();

function closeIx(): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data: Buffer.from([9]),
  });
}

/** A real serialized repair transaction whose fee transfer lands in
 *  `toWallet` (the shape getTransaction(base64) returns). */
function feeRawTx(toWallet: string): unknown {
  const payer = Keypair.generate().publicKey;
  const tx = new Transaction({
    feePayer: payer,
    recentBlockhash: RECENT_BLOCKHASH,
  });
  tx.add(closeIx());
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: new PublicKey(toWallet),
      lamports: 20_392,
    })
  );
  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  return {
    blockTime: 1_755_577_001,
    version: null,
    meta: { err: null, innerInstructions: [] },
    transaction: [serialized.toString("base64"), "base64"],
  };
}

type Deferred = { resolve: (value: unknown) => void };

describe("useFeeLedger loadMore stale-response guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("discards a loadMore response that lands after a cluster switch", async () => {
    const MAINNET_FEE = feeRawTx(MAINNET_WALLET);
    const DEVNET_FEE = feeRawTx(DEVNET_WALLET);
    // Signature -> transaction response; unlisted signatures are pruned.
    const txFor: Record<string, unknown> = {
      "m-1": MAINNET_FEE,
      "d-1": DEVNET_FEE,
      "m-99": MAINNET_FEE,
    };
    const parked: Deferred[] = [];

    const jsonResponse = (result: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ result }),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body)) as {
          method: string;
          params: unknown[];
        };
        if (body.method === "getSignaturesForAddress") {
          const wallet = body.params[0] as string;
          const before = (body.params[1] as { before?: string } | undefined)
            ?.before;
          // The load-more call on mainnet (paged past m-2): park it so
          // the test controls when the stale response arrives.
          if (wallet === MAINNET_WALLET && before === "m-2") {
            return new Promise((resolve) => {
              parked.push({ resolve: resolve as (v: unknown) => void });
            });
          }
          if (wallet === MAINNET_WALLET) {
            return jsonResponse([
              { signature: "m-1", blockTime: 1_755_577_001 },
              { signature: "m-2", blockTime: 1_755_577_000 },
            ]);
          }
          return jsonResponse([
            { signature: "d-1", blockTime: 1_755_577_001 },
            { signature: "d-2", blockTime: 1_755_577_000 },
          ]);
        }
        // getTransaction
        const sig = body.params[0] as string;
        return jsonResponse(txFor[sig] ?? null);
      })
    );

    const { result } = renderHook(() => useFeeLedger());

    // Page 1 on mainnet lands: one fee row (m-1), raw cursor m-2.
    await waitFor(() => {
      expect(result.current.rows.map((r) => r.signature)).toEqual(["m-1"]);
    });

    // loadMore starts on mainnet and hangs at the RPC boundary.
    await act(async () => {
      void result.current.loadMore();
    });
    expect(parked).toHaveLength(1);

    // While it hangs, the user switches to devnet; the fresh page
    // (one fee row, d-1) renders.
    await act(async () => {
      result.current.setCluster("devnet");
    });
    await waitFor(() => {
      expect(result.current.rows.map((r) => r.signature)).toEqual(["d-1"]);
    });

    // The abandoned mainnet loadMore finally resolves with a page that
    // contains a real fee row (m-99). It must be discarded, not
    // stamped into the devnet view.
    await act(async () => {
      parked[0].resolve(
        jsonResponse([{ signature: "m-99", blockTime: 1_755_576_900 }])
      );
      await new Promise((r) => setTimeout(r, 300));
    });

    expect(result.current.rows.map((r) => r.signature)).toEqual(["d-1"]);
    expect(result.current.error).toBeNull();
    // The stale run must not leave the load-more button stuck.
    expect(result.current.loadingMore).toBe(false);
  });
});
