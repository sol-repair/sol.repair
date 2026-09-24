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

describe("G.2 evidence: delegate address and nativeStatus (additive only)", () => {
  it("carries the delegate address alongside delegated on a funded skip", async () => {
    const delegate = pk(20).toBase58();
    const result = await scan([
      tokenAccountEntry({ seed: 21, amount: "7", delegate }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.delegated).toBe(true);
    expect(skipped.delegate).toBe(delegate);
    // The classification outcome is unchanged, byte for byte.
    expect(skipped.reason).toBe("holds a token balance");
    expect(result.eligibleAccounts).toHaveLength(0);
  });

  it("maps the parsed isNative value onto the three nativeStatus states", async () => {
    const native = await scan([
      tokenAccountEntry({ seed: 22, amount: "7", isNative: true }),
    ]);
    expect(native.skippedAccounts[0].nativeStatus).toBe("native");

    const nonNative = await scan([
      tokenAccountEntry({ seed: 23, amount: "7", isNative: false }),
    ]);
    expect(nonNative.skippedAccounts[0].nativeStatus).toBe("non-native");

    // The fixture always writes isNative; an explicit undefined via a
    // raw envelope proves no defaulting: unknown stays unknown.
    const rawEntry = tokenAccountEntry({ seed: 24, amount: "7" });
    const info = (
      rawEntry.account.data as { parsed: { info: Record<string, unknown> } }
    ).parsed.info;
    delete info.isNative;
    const unknown = await scan([rawEntry]);
    expect(unknown.skippedAccounts[0].nativeStatus).toBe("unknown");
  });

  it("carries the delegate address and non-native status on the frozen-with-delegate skip", async () => {
    const delegate = pk(25).toBase58();
    const result = await scan([
      tokenAccountEntry({
        seed: 26,
        amount: "0",
        delegate,
        state: "frozen",
      }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.cause).toBe("frozen-with-delegate");
    expect(skipped.delegated).toBe(true);
    expect(skipped.delegate).toBe(delegate);
    // Reached only after the isNative check passed, so always
    // non-native here — derived, not special-cased.
    expect(skipped.nativeStatus).toBe("non-native");
    expect(skipped.reason).toBe("is frozen with an active delegate");
  });

  it("keeps classification identical across all three nativeStatus states", async () => {
    for (const isNative of [true, false] as const) {
      const result = await scan([
        tokenAccountEntry({ seed: 27, amount: "9", isNative }),
      ]);
      expect(result.skippedAccounts[0].cause).toBe("funded");
      expect(result.skippedAccounts[0].reason).toBe("holds a token balance");
      expect(result.eligibleAccounts).toHaveLength(0);
    }
  });

  it("leaves empty eligible accounts without the G.2 fields either", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 28, amount: "0", delegate: pk(29).toBase58() }),
    ]);
    const eligible = result.eligibleAccounts[0];
    expect(eligible.needsRevoke).toBe(true);
    expect((eligible as { delegate?: string }).delegate).toBeUndefined();
    expect(
      (eligible as { nativeStatus?: string }).nativeStatus
    ).toBeUndefined();
  });
});

describe("G.3 evidence: the wrapped-sol skip carries lamports and nativeStatus (additive only)", () => {
  it("carries lamports and nativeStatus on the wrapped-sol skip; the reason stays byte-identical", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 40, isNative: true }),
    ]);
    expect(result.skippedAccounts).toHaveLength(1);
    const skipped = result.skippedAccounts[0];
    expect(skipped.reason).toBe("is a wrapped-SOL account"); // unchanged
    expect(skipped.cause).toBe("wrapped-sol");
    expect(skipped.lamports).toBe(2039280);
    expect(Number.isInteger(skipped.lamports)).toBe(true);
    expect(skipped.nativeStatus).toBe("native");
  });

  it("records unknown — never defaulted — when the wrapped-sol envelope omits isNative", async () => {
    const rawEntry = tokenAccountEntry({ seed: 41 });
    const info = (
      rawEntry.account.data as { parsed: { info: Record<string, unknown> } }
    ).parsed.info;
    delete info.isNative;
    const result = await scan([rawEntry]);
    const skipped = result.skippedAccounts[0];
    // The `info.isNative !== false` check admits the omitted field at
    // this site; the additive recording captures that honestly.
    expect(skipped.cause).toBe("wrapped-sol");
    expect(skipped.reason).toBe("is a wrapped-SOL account"); // unchanged
    expect(skipped.nativeStatus).toBe("unknown");
    expect(skipped.lamports).toBe(2039280);
  });

  it("adds no balance or decimals at the wrapped-sol site (the zero is a derivation, not a field)", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 42, isNative: true }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.balance).toBeUndefined();
    expect(skipped.decimals).toBeUndefined();
  });

  it("leaves the funded native skip's G.2 shape unchanged (no new field)", async () => {
    const result = await scan([
      tokenAccountEntry({ seed: 43, amount: "7", isNative: true }),
    ]);
    const skipped = result.skippedAccounts[0];
    expect(skipped.cause).toBe("funded");
    expect(skipped.reason).toBe("holds a token balance"); // unchanged
    expect(skipped.balance).toBe("7");
    expect(skipped.decimals).toBe(6);
    expect(skipped.lamports).toBe(2039280);
    expect(skipped.nativeStatus).toBe("native"); // G.2, already shipped
    expect(result.eligibleAccounts).toHaveLength(0);
  });

  it("keeps classification byte-identical across the three nativeStatus states at the wrapped-sol site", async () => {
    // Explicit true: wrapped-sol skip, unchanged reason, still skipped.
    const native = await scan([
      tokenAccountEntry({ seed: 44, isNative: true }),
    ]);
    expect(native.skippedAccounts[0].cause).toBe("wrapped-sol");
    expect(native.skippedAccounts[0].reason).toBe("is a wrapped-SOL account");
    expect(native.eligibleAccounts).toHaveLength(0);

    // Omitted field (unknown): identical outcome — never defaulted.
    const rawEntry = tokenAccountEntry({ seed: 45 });
    const info = (
      rawEntry.account.data as { parsed: { info: Record<string, unknown> } }
    ).parsed.info;
    delete info.isNative;
    const unknown = await scan([rawEntry]);
    expect(unknown.skippedAccounts[0].cause).toBe("wrapped-sol");
    expect(unknown.skippedAccounts[0].reason).toBe("is a wrapped-SOL account");
    expect(unknown.eligibleAccounts).toHaveLength(0);

    // Explicit false: eligible — the pre-G.3 partition, unchanged.
    const nonNative = await scan([
      tokenAccountEntry({ seed: 46, isNative: false }),
    ]);
    expect(nonNative.skippedAccounts).toHaveLength(0);
    expect(nonNative.eligibleAccounts).toHaveLength(1);
  });
});
