/**
 * Tests for the excess-lamports lib (docs/g4-excess-lamports-spec-draft.md
 * Revision 1). The wire format is verified against the Token-2022
 * program source: tag 38, keys source(writable)/destination(writable)/
 * authority(signer, the account's owner), no data beyond the tag.
 */

import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  buildWithdrawExcessInstruction,
  collectToken2022Keys,
  detectExcessCandidates,
  evaluateExcessGate,
  readExcessState,
  WITHDRAW_EXCESS_LAMPORTS_TAG,
} from "../src/lib/solana/excessLamports";
import type {
  ScanResult,
  SkippedAccount,
} from "../src/lib/solana/tokenAccounts";

const OWNER = Keypair.generate();
const TOKENZ = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

describe("buildWithdrawExcessInstruction", () => {
  it("builds the verified wire format: tag 38, three keys, owner signs", () => {
    const account = Keypair.generate().publicKey;
    const ix = buildWithdrawExcessInstruction(
      { pubkey: account.toBase58() },
      OWNER.publicKey
    );
    expect(ix.programId.equals(TOKENZ)).toBe(true);
    expect(ix.data).toHaveLength(1);
    expect(ix.data[0]).toBe(WITHDRAW_EXCESS_LAMPORTS_TAG);
    expect(ix.data[0]).toBe(38);
    expect(ix.keys).toHaveLength(3);
    // source: writable, not a signer
    expect(ix.keys[0].pubkey.equals(account)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[0].isSigner).toBe(false);
    // destination: the connected owner, writable
    expect(ix.keys[1].pubkey.equals(OWNER.publicKey)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    // authority: the owner, the sole signer, not writable
    expect(ix.keys[2].pubkey.equals(OWNER.publicKey)).toBe(true);
    expect(ix.keys[2].isSigner).toBe(true);
    expect(ix.keys[2].isWritable).toBe(false);
  });
});

describe("collectToken2022Keys", () => {
  const ELIGIBLE_T22 = {
    pubkey: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    lamports: 2039280,
    program: "token-2022" as const,
  };
  const NATIVE_MINT_2022 = "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP";

  function scanWith(
    eligible: typeof ELIGIBLE_T22[],
    skipped: SkippedAccount[]
  ): ScanResult {
    return {
      totalAccounts: eligible.length + skipped.length,
      eligibleAccounts: eligible,
      recoverableLamports: 0n,
      skippedAccounts: skipped,
    };
  }

  it("collects the scan's Token-2022 keys from eligible and skipped", () => {
    const keys = collectToken2022Keys(
      scanWith([ELIGIBLE_T22], [
        {
          pubkey: Keypair.generate().publicKey.toBase58(),
          mint: Keypair.generate().publicKey.toBase58(),
          reason: "holds a token balance",
          program: "token-2022",
          cause: "funded",
          balance: "5",
          decimals: 6,
          lamports: 2074254,
          nativeStatus: "non-native",
        },
      ])
    );
    expect(keys).toHaveLength(2);
  });

  it("excludes wrapped-SOL accounts (native) and unknown status", () => {
    const keys = collectToken2022Keys(
      scanWith([], [
        {
          pubkey: Keypair.generate().publicKey.toBase58(),
          mint: NATIVE_MINT_2022,
          reason: "is a wrapped-SOL account",
          program: "token-2022",
          cause: "wrapped-sol",
          lamports: 15239280,
          nativeStatus: "native",
        },
        {
          pubkey: Keypair.generate().publicKey.toBase58(),
          mint: Keypair.generate().publicKey.toBase58(),
          reason: "holds a token balance",
          program: "token-2022",
          cause: "funded",
          balance: "5",
          decimals: 6,
          lamports: 2074254,
          nativeStatus: "unknown",
        },
      ])
    );
    expect(keys).toHaveLength(0);
  });

  it("keeps frozen Token-2022 accounts (the program never checks frozen)", () => {
    const keys = collectToken2022Keys(
      scanWith([], [
        {
          pubkey: Keypair.generate().publicKey.toBase58(),
          mint: Keypair.generate().publicKey.toBase58(),
          reason: "holds a token balance",
          program: "token-2022",
          cause: "funded",
          balance: "5",
          decimals: 6,
          lamports: 2074254,
          frozen: true,
          nativeStatus: "non-native",
        },
      ])
    );
    expect(keys).toHaveLength(1);
  });

  it("deduplicates an account that appears in more than one list", () => {
    const pubkey = Keypair.generate().publicKey.toBase58();
    const keys = collectToken2022Keys(
      scanWith([{ ...ELIGIBLE_T22, pubkey }], [
        {
          pubkey,
          mint: Keypair.generate().publicKey.toBase58(),
          reason: "holds a token balance",
          program: "token-2022",
          cause: "funded",
          balance: "5",
          decimals: 6,
          lamports: 2074254,
          nativeStatus: "non-native",
        },
      ])
    );
    expect(keys).toHaveLength(1);
  });
});


const RESERVE = 1488440;
function accountRaw(lamports: number, dataLen = 165) {
  return {
    lamports,
    owner: Keypair.generate().publicKey,
    data: new Uint8Array(dataLen),
    executable: false,
    rentEpoch: null,
  };
}
describe("detectExcessCandidates", () => {
  it("pairs keys with their accounts and caches the reserve per data length", async () => {
    const keyA = Keypair.generate().publicKey.toBase58();
    const keyB = Keypair.generate().publicKey.toBase58();
    const keyC = Keypair.generate().publicKey.toBase58();
    // A and C share one data length; B is missing from the response
    // (skipped); C sits at the reserve (excluded).
    const rawAccounts = [accountRaw(2000000, 165), null, accountRaw(RESERVE, 165)];
    const reserveCalls = vi.fn(() => RESERVE);
    const connection = {
      getMultipleAccountsInfo: vi.fn(async () => rawAccounts),
      getMinimumBalanceForRentExemption: reserveCalls as unknown as (
        dataLen: number,
        commitment?: string
      ) => Promise<number>,
    };
    const out = await detectExcessCandidates(connection, [
      { pubkey: keyA, mint: "MINT_A" },
      { pubkey: keyB },
      { pubkey: keyC },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].pubkey).toBe(keyA);
    expect(out[0].mint).toBe("MINT_A");
    expect(out[0].excess).toBe(2000000 - RESERVE);
    // One reserve read per unique data length, not per account.
    expect(reserveCalls.mock.calls).toHaveLength(1);
    // One batched read covering all three keys.
    expect(connection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });

  it("chunks detection reads at 100 keys per RPC call", async () => {
    const keys = Array.from({ length: 250 }, () => ({
      pubkey: Keypair.generate().publicKey.toBase58(),
    }));
    const sizes: number[] = [];
    const connection = {
      getMultipleAccountsInfo: vi.fn(async (chunk: PublicKey[]) => {
        sizes.push(chunk.length);
        return chunk.map(() => accountRaw(RESERVE));
      }),
      getMinimumBalanceForRentExemption: (async () => RESERVE) as unknown as (
        dataLen: number,
        commitment?: string
      ) => Promise<number>,
    };
    const out = await detectExcessCandidates(connection, keys);
    expect(sizes).toEqual([100, 100, 50]);
    expect(out).toHaveLength(0); // everything sits at the reserve
  });
});

describe("evaluateExcessGate", () => {
  it("passes with the current excess and lamports", () => {
    const verdict = evaluateExcessGate(
      {
        kind: "read",
        lamports: 2000000,
        dataLen: 165,
        excess: 511560,
        program: TOKENZ.toBase58(),
        accountOwner: OWNER.publicKey.toBase58(),
      }
    );
    expect(verdict.kind).toBe("pass");
    if (verdict.kind === "pass") {
      expect(verdict.excessBeforeAction).toBe(511560);
      expect(verdict.lamportsBeforeAction).toBe(2000000);
    }
  });

  it("passes with drifted figures (Case B: drain what exists at land time)", () => {
    const verdict = evaluateExcessGate(
      {
        kind: "read",
        lamports: 2100000,
        dataLen: 165,
        excess: 611560,
        program: TOKENZ.toBase58(),
        accountOwner: OWNER.publicKey.toBase58(),
      }
    );
    expect(verdict.kind).toBe("pass");
  });

  it("reports already-withdrawn when the excess is gone", () => {
    const verdict = evaluateExcessGate(
      { kind: "read", lamports: 1488440, dataLen: 165, excess: 0, program: TOKENZ.toBase58(), accountOwner: OWNER.publicKey.toBase58() }
    );
    expect(verdict.kind).toBe("already-withdrawn");
  });

  it("reports already-gone and the RPC abort", () => {
    expect(evaluateExcessGate({ kind: "missing" }).kind).toBe(
      "already-gone"
    );
    const failed = evaluateExcessGate({ kind: "rpc-failed" });
    expect(failed).toEqual({
      kind: "abort",
      sentence:
        "The current account state could not be read. Nothing was signed.",
    });
  });
});

/* ------------------------------------------------------------------ */
/* The close-blocked-extension side effect, pinned on owner order      */
/* ------------------------------------------------------------------ */

describe("collectToken2022Keys keeps close-blocked skips excess-detectable", () => {
  function scanWithSkipped(skipped: SkippedAccount[]): ScanResult {
    return {
      totalAccounts: skipped.length,
      eligibleAccounts: [],
      recoverableLamports: 0n,
      skippedAccounts: skipped,
    };
  }

  it("includes a close-blocked-extension skip with non-native status", () => {
    const keys = collectToken2022Keys(
      scanWithSkipped([
        {
          pubkey: Keypair.generate().publicKey.toBase58(),
          mint: Keypair.generate().publicKey.toBase58(),
          reason:
            "holds a withheld transfer fee only the mint's fee authority can release",
          program: "token-2022",
          cause: "close-blocked-extension",
          lamports: 2039280,
          nativeStatus: "non-native",
          extensionBlocker: "withheld-fee",
        },
      ])
    );
    expect(keys).toHaveLength(1);
    expect(keys[0].nativeStatus).toBe("non-native");
    expect(keys[0].frozen).toBe(false);
  });

  it("includes an extension-unreadable skip the same way", () => {
    const keys = collectToken2022Keys(
      scanWithSkipped([
        {
          pubkey: Keypair.generate().publicKey.toBase58(),
          mint: Keypair.generate().publicKey.toBase58(),
          reason: "its extensions could not be read",
          program: "token-2022",
          cause: "extension-unreadable",
          lamports: 2039280,
          nativeStatus: "non-native",
        },
      ])
    );
    expect(keys).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* The gate identity re-check and the commitment pin (audit M3 + L6)   */
/* ------------------------------------------------------------------ */

const T22_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Raw account whose data carries the given owner pubkey at bytes
 *  32..64 (the fixed base-account layout). */
function ownedRaw(
  owner: PublicKey,
  lamports = 2000000,
  dataLen = 165
): { owner: PublicKey; lamports: number; data: Uint8Array } {
  const data = new Uint8Array(dataLen);
  if (dataLen >= 64) {
    data.set(owner.toBytes(), 32);
  }
  return { owner: new PublicKey(T22_PROGRAM), lamports, data };
}

describe("readExcessState", () => {
  it("returns identity evidence and pins confirmed on both reads", async () => {
    const foreigner = Keypair.generate().publicKey;
    const calls: Array<unknown> = [];
    const rentCalls: Array<unknown> = [];
    const connection = {
      getMultipleAccountsInfo: vi.fn(async (_keys: PublicKey[], config?: unknown) => {
        calls.push(config);
        return [ownedRaw(foreigner)];
      }),
      getMinimumBalanceForRentExemption: vi.fn(async (_dataLen: number, commitment?: unknown) => {
        rentCalls.push(commitment);
        return RESERVE;
      }),
    };
    const read = await readExcessState(connection, Keypair.generate().publicKey.toBase58());
    expect(read.kind).toBe("read");
    if (read.kind === "read") {
      expect(read.program).toBe(T22_PROGRAM);
      expect(read.accountOwner).toBe(foreigner.toBase58());
      expect(read.lamports).toBe(2000000);
      expect(read.excess).toBe(2000000 - RESERVE);
    }
    // L6: the action read is pinned to confirmed, matching the confirm
    // path and the sibling flows.
    expect(calls).toEqual([{ commitment: "confirmed" }]);
    expect(rentCalls).toEqual(["confirmed"]);
  });

  it("reports a null accountOwner when the data is too short to hold one", async () => {
    const connection = {
      getMultipleAccountsInfo: vi.fn(async () => [ownedRaw(OWNER.publicKey, 2000000, 40)]),
      getMinimumBalanceForRentExemption: vi.fn(async () => RESERVE),
    };
    const read = await readExcessState(connection, Keypair.generate().publicKey.toBase58());
    expect(read.kind).toBe("read");
    if (read.kind === "read") expect(read.accountOwner).toBeNull();
  });

  it("reports a missing account", async () => {
    const connection = {
      getMultipleAccountsInfo: vi.fn(async () => [null]),
      getMinimumBalanceForRentExemption: vi.fn(async () => RESERVE),
    };
    expect(
      (await readExcessState(connection, Keypair.generate().publicKey.toBase58())).kind
    ).toBe("missing");
  });
});

describe("evaluateExcessGate identity checks", () => {
  const connectedOwner = OWNER.publicKey.toBase58();

  it("aborts with the approved sentence on a wrong owning program", () => {
    const verdict = evaluateExcessGate(
      {
        kind: "read",
        lamports: 2000000,
        dataLen: 165,
        excess: 511560,
        program: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBase58(),
        accountOwner: connectedOwner,
      },
      connectedOwner
    );
    expect(verdict).toEqual({
      kind: "abort",
      sentence:
        "This address no longer holds a Token-2022 token account. Nothing was signed.",
    });
  });

  it("aborts with the approved sentence on a foreign account owner", () => {
    const foreigner = Keypair.generate().publicKey.toBase58();
    const verdict = evaluateExcessGate(
      {
        kind: "read",
        lamports: 2000000,
        dataLen: 165,
        excess: 511560,
        program: T22_PROGRAM,
        accountOwner: foreigner,
      },
      connectedOwner
    );
    expect(verdict).toEqual({
      kind: "abort",
      sentence:
        "This account is no longer owned by the connected wallet. Nothing was signed.",
    });
  });

  it("aborts on a null accountOwner with the not-a-token-account sentence (owner-ordered gate-level pin)", () => {
    const verdict = evaluateExcessGate(
      {
        kind: "read",
        lamports: 2000000,
        dataLen: 40,
        excess: 2000000 - RESERVE,
        program: T22_PROGRAM,
        accountOwner: null,
      },
      connectedOwner
    );
    expect(verdict).toEqual({
      kind: "abort",
      sentence:
        "This address no longer holds a Token-2022 token account. Nothing was signed.",
    });
  });

  it("puts identity ahead of already-withdrawn (a foreign recreation is not 'already withdrawn')", () => {
    const foreigner = Keypair.generate().publicKey.toBase58();
    const verdict = evaluateExcessGate(
      {
        kind: "read",
        lamports: RESERVE,
        dataLen: 165,
        excess: 0,
        program: T22_PROGRAM,
        accountOwner: foreigner,
      },
      connectedOwner
    );
    expect(verdict).toEqual({
      kind: "abort",
      sentence:
        "This account is no longer owned by the connected wallet. Nothing was signed.",
    });
  });

  it("passes with figures unchanged when identity matches, including drift", () => {
    const verdict = evaluateExcessGate(
      {
        kind: "read",
        lamports: 2100000,
        dataLen: 165,
        excess: 611560,
        program: T22_PROGRAM,
        accountOwner: connectedOwner,
      },
      connectedOwner
    );
    expect(verdict.kind).toBe("pass");
    if (verdict.kind === "pass") {
      expect(verdict.excessBeforeAction).toBe(611560);
      expect(verdict.lamportsBeforeAction).toBe(2100000);
    }
  });

  it("skips identity when no connected owner is supplied (back-compat)", () => {
    const verdict = evaluateExcessGate({
      kind: "read",
      lamports: 2000000,
      dataLen: 165,
      excess: 511560,
      program: T22_PROGRAM,
      accountOwner: null,
    });
    expect(verdict.kind).toBe("pass");
  });
});

describe("detectExcessCandidates commitment scope (Option A)", () => {
  it("leaves detection at the node-default commitment (the scan's finalized view)", async () => {
    const configs: Array<unknown> = [];
    const connection = {
      getMultipleAccountsInfo: vi.fn(async (_keys: PublicKey[], config?: unknown) => {
        configs.push(config);
        return [];
      }),
      getMinimumBalanceForRentExemption: vi.fn(async () => RESERVE),
    };
    await detectExcessCandidates(connection, [
      { pubkey: Keypair.generate().publicKey.toBase58() },
    ]);
    expect(configs).toEqual([undefined]);
  });
});
