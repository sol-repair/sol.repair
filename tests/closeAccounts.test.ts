/**
 * Tests for the instruction layer in closeAccounts.ts: the binding
 * that makes the app safe (destination and authority are always the
 * owner, the program matches each account's tag, a delegated account
 * gets its Revoke immediately before its CloseAccount) and the on-chain
 * closed-account verification used after submission errors.
 *
 * Only the RPC boundary is mocked. The instruction construction and
 * the verification logic under test are the real ones.
 */

import { describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type ClosableAccount,
} from "../src/lib/solana/tokenAccounts";
import {
  buildCloseAccountInstructions,
  verifyAccountsClosed,
} from "../src/lib/solana/closeAccounts";

function pk(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  return new PublicKey(bytes);
}

const OWNER = pk(1);

function account(
  seed: number,
  program: "spl" | "token-2022" = "spl"
): ClosableAccount {
  return {
    pubkey: pk(seed).toBase58(),
    mint: pk(seed + 100).toBase58(),
    lamports: 2_039_280,
    program,
  };
}

describe("buildCloseAccountInstructions", () => {
  it("builds exactly one instruction per account", () => {
    const ixs = buildCloseAccountInstructions(
      [account(2), account(3, "token-2022")],
      OWNER
    );
    expect(ixs).toHaveLength(2);
  });

  it("targets the token program that owns each account", () => {
    const ixs = buildCloseAccountInstructions(
      [account(4), account(5, "token-2022")],
      OWNER
    );
    expect(ixs[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[1].programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("binds destination AND authority to the owner's wallet", () => {
    const ixs = buildCloseAccountInstructions([account(6)], OWNER);
    const keys = ixs[0].keys;
    // key order for closeAccount: account, destination, authority
    expect(keys[0].pubkey.equals(pk(6))).toBe(true);
    expect(keys[1].pubkey.equals(OWNER)).toBe(true);
    expect(keys[2].pubkey.equals(OWNER)).toBe(true);
  });

  it("closeAccount carries only the 1-byte discriminator, no arguments", () => {
    const ixs = buildCloseAccountInstructions([account(7)], OWNER);
    // verified against @solana/spl-token 0.4.15: closeAccount encodes
    // as the single instruction-index byte 0x09 with no arguments
    expect(Buffer.from(ixs[0].data).toString("hex")).toBe("09");
  });
});

describe("buildCloseAccountInstructions revoke pairing", () => {
  function flagged(
    seed: number,
    program: "spl" | "token-2022" = "spl"
  ): ClosableAccount {
    return { ...account(seed, program), needsRevoke: true };
  }

  it("emits a Revoke immediately before the close of a flagged account", () => {
    const ixs = buildCloseAccountInstructions([flagged(20)], OWNER);
    expect(ixs).toHaveLength(2);
    // Revoke encodes as instruction-index byte 0x05, CloseAccount 0x09.
    expect(Buffer.from(ixs[0].data).toString("hex")).toBe("05");
    expect(Buffer.from(ixs[1].data).toString("hex")).toBe("09");
  });

  it("binds the revoke authority to the owner as the sole signer", () => {
    const ixs = buildCloseAccountInstructions([flagged(21)], OWNER);
    const revoke = ixs[0];
    expect(revoke.keys).toHaveLength(2);
    expect(revoke.keys[0].pubkey.equals(pk(21))).toBe(true);
    expect(revoke.keys[0].isSigner).toBe(false);
    expect(revoke.keys[0].isWritable).toBe(true);
    expect(revoke.keys[1].pubkey.equals(OWNER)).toBe(true);
    expect(revoke.keys[1].isSigner).toBe(true);
  });

  it("targets each account's own token program for its revoke", () => {
    const ixs = buildCloseAccountInstructions(
      [flagged(22), flagged(23, "token-2022")],
      OWNER
    );
    // ixs[0] is the spl revoke, ixs[2] the token-2022 revoke.
    expect(ixs[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[2].programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("interleaves so each revoke lands directly before its own close", () => {
    const ixs = buildCloseAccountInstructions(
      [account(24), flagged(25), account(26)],
      OWNER
    );
    expect(ixs).toHaveLength(4);
    expect(ixs.map((ix) => Buffer.from(ix.data).toString("hex"))).toEqual([
      "09", "05", "09", "09",
    ]);
    // The revoke and the close it precedes target the same account.
    expect(ixs[1].keys[0].pubkey.equals(pk(25))).toBe(true);
    expect(ixs[2].keys[0].pubkey.equals(pk(25))).toBe(true);
  });

  it("emits no revoke for clean accounts", () => {
    const ixs = buildCloseAccountInstructions(
      [account(27), account(28, "token-2022")],
      OWNER
    );
    expect(ixs.map((ix) => Buffer.from(ix.data).toString("hex"))).toEqual([
      "09", "09",
    ]);
  });
});

describe("verifyAccountsClosed", () => {
  function connectionReturning(
    resolve: (pk: PublicKey) => { owner: PublicKey } | null
  ): Connection {
    return {
      async getMultipleAccountsInfo(pks: PublicKey[]) {
        return pks.map(resolve);
      },
    } as unknown as Connection;
  }

  it("a nonexistent account counts as closed", async () => {
    const { closedPubkeys, stillOpenPubkeys } = await verifyAccountsClosed(
      connectionReturning(() => null),
      [account(8)]
    );
    expect(closedPubkeys).toHaveLength(1);
    expect(stillOpenPubkeys).toHaveLength(0);
  });

  it("an account still owned by a token program counts as open", async () => {
    const result = await verifyAccountsClosed(
      connectionReturning(() => ({ owner: TOKEN_PROGRAM_ID })),
      [account(9), account(10, "token-2022")]
    );
    // same mocked response for both: token-owned means still open
    expect(result.stillOpenPubkeys).toHaveLength(2);
  });

  it("an account recycled to another program counts as closed", async () => {
    // closed token accounts can be reused by the system program;
    // what matters is that no token program owns it anymore
    const result = await verifyAccountsClosed(
      connectionReturning(() => ({ owner: PublicKey.default })),
      [account(11)]
    );
    expect(result.closedPubkeys).toHaveLength(1);
  });

  it("reads at confirmed commitment so verification matches the confirm path", async () => {
    // The repair waits for confirmation at "confirmed", but the RPC's
    // default read commitment is "finalized", which lags the chain by
    // ~12 seconds. In the exact race this function exists for (the
    // wallet submitted the transaction itself moments ago), a
    // finalized-view read still sees the accounts open and turns a
    // succeeded repair into a reported failure. The verification must
    // look at the same view the confirmation did.
    const commitments: Array<string | undefined> = [];
    const connection = {
      async getMultipleAccountsInfo(_pks: PublicKey[], commitment?: string) {
        commitments.push(commitment);
        return [null];
      },
    } as unknown as Connection;
    await verifyAccountsClosed(connection, [account(12)]);
    expect(commitments).toEqual(["confirmed"]);
  });

  it("chunks large verifications instead of one RPC call per account", async () => {
    // The error paths call verification for EVERY account in the repair;
    // one serial getAccountInfo per account turned a large wallet's
    // failure into an RPC storm. Batched reads cap it at ~1% of the
    // calls (100 pubkeys per getMultipleAccountsInfo request).
    const accounts = Array.from({ length: 250 }, (_, i) => account(i));
    const closedElsewhere = new Set(
      accounts.slice(0, 7).map((a) => a.pubkey)
    );
    const callSizes: number[] = [];
    const commitments: Array<string | undefined> = [];
    const connection = {
      async getMultipleAccountsInfo(pks: PublicKey[], commitment?: string) {
        callSizes.push(pks.length);
        commitments.push(commitment);
        return pks.map((pk) =>
          closedElsewhere.has(pk.toBase58())
            ? null
            : { owner: TOKEN_PROGRAM_ID }
        );
      },
    } as unknown as Connection;

    const { closedPubkeys, stillOpenPubkeys } = await verifyAccountsClosed(
      connection,
      accounts
    );

    expect(callSizes).toEqual([100, 100, 50]);
    expect(commitments).toEqual(["confirmed", "confirmed", "confirmed"]);
    // Results stay aligned with the input order: exactly the 7 accounts
    // the chain reports gone are closed, the other 243 still open.
    expect(closedPubkeys).toEqual(accounts.slice(0, 7).map((a) => a.pubkey));
    expect(stillOpenPubkeys).toHaveLength(243);
  });
});
