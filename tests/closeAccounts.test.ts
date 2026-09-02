/**
 * Tests for the instruction layer in closeAccounts.ts: the binding
 * that makes the app safe (destination and authority are always the
 * owner, the program matches each account's tag) and the on-chain
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
