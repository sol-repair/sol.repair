/**
 * Evidence-preservation tests for the G.1 additive fields.
 *
 * getClosableAccounts already validated the parsed RPC response deep-field
 * by deep-field; these tests pin that the validated values (balance,
 * decimals, lamports, delegate presence, frozen state) now travel on the
 * result objects as evidence for the inspection layer, WITHOUT changing any
 * classification outcome or the seven pinned reason strings.
 */

import { describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  getClosableAccounts,
  TOKEN_PROGRAM_ID,
} from "@/lib/solana/tokenAccounts";

const pk = (seed: number) => new PublicKey(Buffer.alloc(32, seed));
const OWNER = pk(1);

/** One parsed-RPC account entry shaped like the real response the scan
 *  requests. Optional parsed fields (delegate, closeAuthority) are OMITTED
 *  from the envelope when undefined, exactly as the RPC omits them. */
const tokenAccountEntry = (opts: {
  seed: number;
  amount?: string;
  decimals?: number;
  delegate?: string;
  closeAuthority?: string;
  state?: "initialized" | "frozen" | "uninitialized";
  isNative?: boolean;
  lamports?: number;
}) => ({
  pubkey: pk(opts.seed),
  account: {
    lamports: opts.lamports ?? 2039280,
    data: {
      parsed: {
        info: {
          mint: pk(opts.seed + 100),
          owner: OWNER,
          tokenAmount: {
            amount: opts.amount ?? "0",
            decimals: opts.decimals ?? 6,
            uiAmount: null,
            uiAmountString: "0",
          },
          ...(opts.delegate === undefined ? {} : { delegate: opts.delegate }),
          ...(opts.closeAuthority === undefined
            ? {}
            : { closeAuthority: opts.closeAuthority }),
          state: opts.state ?? "initialized",
          isNative: opts.isNative ?? false,
        },
      },
    },
    owner: TOKEN_PROGRAM_ID,
  },
});

const connection = (entries: unknown[]) =>
  ({
    // The real scan queries each token program separately; answer only the
    // classic SPL program so entries are not scanned (and counted) twice.
    getParsedTokenAccountsByOwner: async (
      _owner: PublicKey,
      config: { programId: PublicKey }
    ) =>
      config.programId.equals(TOKEN_PROGRAM_ID)
        ? { value: entries }
        : { value: [] },
  }) as unknown as Connection;

const scan = async (entries: unknown[]) =>
  getClosableAccounts(connection(entries), OWNER);

describe("G.1 evidence preservation in getClosableAccounts", () => {
  it("carries balance, decimals, and lamports on a funded account", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 2, amount: "1000000", decimals: 6 }),
    ]);
    expect(result.skippedAccounts).toHaveLength(1);
    const skipped = result.skippedAccounts[0];
    expect(skipped.reason).toBe("holds a token balance"); // unchanged
    expect(skipped.cause).toBe("funded");
    expect(skipped.balance).toBe("1000000");
    expect(skipped.decimals).toBe(6);
    expect(skipped.lamports).toBe(2039280);
    expect(skipped.delegated).toBeUndefined();
  });

  it("carries delegate presence on a funded delegated account", async () => {
    const result = await scan([
      tokenAccountEntry({
        seed: 3,
        amount: "7",
        delegate: pk(9).toBase58(),
      }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.reason).toBe("holds a token balance"); // unchanged
    expect(skipped.cause).toBe("funded");
    expect(skipped.delegated).toBe(true);
    // The classification outcome is unchanged: still skipped, not closable.
    expect(result.eligibleAccounts).toHaveLength(0);
  });

  it("marks a frozen funded account with frozen evidence and its unchanged reason", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 4, amount: "5", state: "frozen" }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.reason).toBe("is frozen by the token's freeze authority"); // unchanged
    expect(skipped.cause).toBe("funded");
    expect(skipped.balance).toBe("5");
    expect(skipped.frozen).toBe(true);
  });

  it("marks a frozen EMPTY eligible account as closable AND frozen", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 5, amount: "0", state: "frozen" }),
    ]);
    expect(result.skippedAccounts).toHaveLength(0);
    const eligible = result.eligibleAccounts[0];
    expect(eligible.frozen).toBe(true);
    // Existing eligibility facts unchanged.
    expect(eligible.needsRevoke).toBeUndefined();
    expect(result.recoverableLamports).toBe(2039280n);
  });

  it("tags the foreign close authority skip", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 6, closeAuthority: pk(8).toBase58() }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.reason).toBe("close authority belongs to another address"); // unchanged
    expect(skipped.cause).toBe("close-authority");
    expect(skipped.balance).toBeUndefined();
  });

  it("tags the wrapped SOL skip", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 7, isNative: true }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.reason).toBe("is a wrapped-SOL account"); // unchanged
    expect(skipped.cause).toBe("wrapped-sol");
  });

  it("tags the uninitialized skip", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 8, state: "uninitialized" }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.reason).toBe("is not initialized"); // unchanged
    expect(skipped.cause).toBe("uninitialized");
  });

  it("tags the frozen delegated skip and preserves its delegate evidence", async () => {
    const result = await scan([
      tokenAccountEntry({
        seed: 10,
        amount: "0",
        delegate: pk(11).toBase58(),
        state: "frozen",
      }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.reason).toBe("is frozen with an active delegate"); // unchanged
    expect(skipped.cause).toBe("frozen-with-delegate");
    expect(skipped.delegated).toBe(true);
    expect(result.eligibleAccounts).toHaveLength(0);
  });

  it("tags malformed-number responses as unreadable and carries no balance evidence", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 12, amount: "12.5" }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.reason).toBe("response could not be read (malformed RPC data)"); // unchanged
    expect(skipped.cause).toBe("unreadable");
    expect(skipped.balance).toBeUndefined();
    expect(skipped.lamports).toBeUndefined();
  });

  it("leaves an empty eligible account without any of the new evidence fields", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 13, amount: "0" }),
    ]);
    expect(result.skippedAccounts).toHaveLength(0);
    const eligible = result.eligibleAccounts[0];
    expect(eligible.frozen).toBeUndefined();
    expect(eligible.needsRevoke).toBeUndefined();
  });
});
