import { describe, expect, it } from "vitest";
import {
  AuthorityType,
  createApproveInstruction,
  createCloseAccountInstruction,
  createRevokeInstruction,
  createSetAuthorityInstruction,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";

import { analyzeLeftBehind } from "@/lib/solana/postState";
import type { DecodedInstruction } from "@/lib/solana/feeLedger";
import { decodeRawTransaction } from "@/lib/solana/feeLedger";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@/lib/solana/tokenAccounts";
import {
  buildLegacyRaw,
  systemTransfer as systemTransferIx,
} from "./fixtures/rawTransactions";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SPL_TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();
const COMPUTE_BUDGET_PROGRAM =
  "ComputeBudget111111111111111111111111111111";
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

const U64_MAX = 18_446_744_073_709_551_615n;

/** Token wire shape: tag byte, optional u64 LE at offset 1, optional
 *  trailing bytes (authority type, option, key). */
function tokenIx(
  programId: string,
  tag: number,
  accountPubkeys: string[],
  u64?: bigint,
  extra?: number[]
): DecodedInstruction {
  const total =
    1 + (u64 === undefined ? 0 : 8) + (extra?.length ?? 0);
  const data = new Uint8Array(total);
  data[0] = tag;
  if (u64 !== undefined) {
    new DataView(data.buffer).setBigUint64(1, u64, true);
  }
  if (extra) data.set(extra, 1 + (u64 === undefined ? 0 : 8));
  return { programId, accountPubkeys, data };
}

describe("analyzeLeftBehind verdicts and headlines", () => {
  it("reports a failed transaction as changed nothing", () => {
    const analysis = analyzeLeftBehind({
      instructions: [
        tokenIx(SPL_TOKEN_PROGRAM, 4, ["a", "b"], 100n),
      ],
      failed: true,
    });
    expect(analysis.verdict).toBe("failed");
    expect(analysis.effects).toEqual([]);
    expect(analysis.headline).toBe(
      "This transaction failed on chain. It changed nothing: no balances moved and nothing was left behind."
    );
  });

  it("says a plain transfer-only transaction left nothing behind", () => {
    const { raw } = buildLegacyRaw([
      systemTransferIx(Keypair.generate().publicKey, 5_000),
    ]);
    const decoded = decodeRawTransaction(raw)!;
    const analysis = analyzeLeftBehind({
      instructions: decoded.instructions,
      failed: false,
    });
    expect(analysis.verdict).toBe("normal");
    expect(analysis.effects).toEqual([]);
    expect(analysis.headline).toBe(
      "This transaction left nothing behind. It only moved balances and paid fees."
    );
  });

  it("keeps compute budget unknowns out of the verdict (they only configure this transaction)", () => {
    const analysis = analyzeLeftBehind({
      instructions: [
        {
          programId: COMPUTE_BUDGET_PROGRAM,
          accountPubkeys: [],
          data: new Uint8Array([0x16, 1, 2, 3]),
        },
      ],
      failed: false,
    });
    expect(analysis.verdict).toBe("normal");
    expect(analysis.effects).toEqual([]);
  });
});

describe("analyzeLeftBehind token capabilities", () => {
  it("flags an approve as a standing spending permission with the delegate named", () => {
    const analysis = analyzeLeftBehind({
      instructions: [tokenIx(SPL_TOKEN_PROGRAM, 4, ["source", "delegate"], 250n)],
      failed: false,
    });
    expect(analysis.verdict).toBe("warning");
    expect(analysis.effects).toEqual([
      {
        severity: "warning",
        text: "Address delegate can now spend up to 250 base units from token account source. This ends if the delegate is revoked.",
      },
    ]);
  });

  it("calls a maximum-value approve unlimited", () => {
    const analysis = analyzeLeftBehind({
      instructions: [
        tokenIx(SPL_TOKEN_PROGRAM, 4, ["source", "delegate"], U64_MAX),
      ],
      failed: false,
    });
    expect(analysis.verdict).toBe("warning");
    expect(analysis.effects[0].text).toBe(
      "Address delegate can now spend an unlimited amount from token account source. This ends if the delegate is revoked."
    );
  });

  it("lists a revoke as an ended permission and keeps the verdict normal", () => {
    const analysis = analyzeLeftBehind({
      instructions: [tokenIx(SPL_TOKEN_PROGRAM, 5, ["source", "owner"])],
      failed: false,
    });
    expect(analysis.verdict).toBe("normal");
    expect(analysis.effects).toEqual([
      {
        severity: "info",
        text: "The delegate on token account source was removed. One standing permission ended.",
      },
    ]);
    expect(analysis.headline).toContain("granted no new permissions");
  });

  it("marks handing the account owner to a different address as the one danger", () => {
    const current = Keypair.generate().publicKey;
    const granted = Keypair.generate().publicKey;
    const analysis = analyzeLeftBehind({
      instructions: [
        tokenIx(SPL_TOKEN_PROGRAM, 6, ["acct", current.toBase58()], undefined, [
          2,
          1,
          ...granted.toBytes(),
        ]),
      ],
      failed: false,
    });
    expect(analysis.verdict).toBe("danger");
    expect(analysis.effects[0].severity).toBe("danger");
    expect(analysis.effects[0].text).toContain(granted.toBase58());
    expect(analysis.headline).toContain("hands control");
  });

  it("treats re-granting the owner to its current holder as a no-op", () => {
    const current = Keypair.generate().publicKey;
    const analysis = analyzeLeftBehind({
      instructions: [
        tokenIx(SPL_TOKEN_PROGRAM, 6, ["acct", current.toBase58()], undefined, [
          2,
          1,
          ...current.toBytes(),
        ]),
      ],
      failed: false,
    });
    expect(analysis.verdict).toBe("normal");
    expect(analysis.effects[0].severity).toBe("info");
    expect(analysis.effects[0].text).toContain("remains");
  });

  it("warns on granting the mint, freeze, and close authorities", () => {
    const granted = Keypair.generate().publicKey;
    const key = [...granted.toBytes()];
    const analysis = analyzeLeftBehind({
      instructions: [
        tokenIx(SPL_TOKEN_PROGRAM, 6, ["m", "cur"], undefined, [0, 1, ...key]),
        tokenIx(SPL_TOKEN_PROGRAM, 6, ["m", "cur"], undefined, [1, 1, ...key]),
        tokenIx(SPL_TOKEN_PROGRAM, 6, ["a", "cur"], undefined, [3, 1, ...key]),
      ],
      failed: false,
    });
    expect(analysis.verdict).toBe("warning");
    expect(analysis.effects).toHaveLength(3);
    expect(analysis.effects.every((e) => e.severity === "warning")).toBe(true);
    expect(analysis.effects[0].text).toContain("mint authority");
    expect(analysis.effects[1].text).toContain("freeze authority");
    expect(analysis.effects[2].text).toContain("close authority");
  });

  it("lists authority removals as ended powers", () => {
    const analysis = analyzeLeftBehind({
      instructions: [
        tokenIx(SPL_TOKEN_PROGRAM, 6, ["a", "cur"], undefined, [3, 0]),
      ],
      failed: false,
    });
    expect(analysis.verdict).toBe("normal");
    expect(analysis.effects[0].severity).toBe("info");
    expect(analysis.effects[0].text).toBe(
      "The close authority was removed from a."
    );
  });

  it("notes a closed account ends its permissions with it", () => {
    const analysis = analyzeLeftBehind({
      instructions: [
        tokenIx(SPL_TOKEN_PROGRAM, 9, ["acct", "dest", "owner"]),
      ],
      failed: false,
    });
    expect(analysis.effects[0].severity).toBe("info");
    expect(analysis.effects[0].text).toBe(
      "Token account acct was closed. Any permissions on it ended with the account."
    );
  });

  it("warns that a freeze locks the account until thawed", () => {
    const analysis = analyzeLeftBehind({
      instructions: [tokenIx(TOKEN_2022_PROGRAM, 10, ["acct", "auth"])],
      failed: false,
    });
    expect(analysis.verdict).toBe("warning");
    expect(analysis.effects[0].text).toContain("frozen");
  });

  it("lists a thaw as the end of a freeze", () => {
    const analysis = analyzeLeftBehind({
      instructions: [tokenIx(TOKEN_2022_PROGRAM, 11, ["acct", "auth"])],
      failed: false,
    });
    expect(analysis.effects[0].severity).toBe("info");
    expect(analysis.effects[0].text).toContain("thawed");
  });

  it("treats transfers, checked transfers, mints, and burns as leaving nothing behind", () => {
    const analysis = analyzeLeftBehind({
      instructions: [
        tokenIx(SPL_TOKEN_PROGRAM, 3, ["a", "b"], 1n),
        tokenIx(SPL_TOKEN_PROGRAM, 7, ["m", "d", "a"], 1n),
        tokenIx(SPL_TOKEN_PROGRAM, 8, ["a", "o"], 1n),
      ],
      failed: false,
    });
    expect(analysis.effects).toEqual([]);
    expect(analysis.verdict).toBe("normal");
  });

  it("warns honestly on a token instruction it does not analyze", () => {
    const analysis = analyzeLeftBehind({
      instructions: [tokenIx(SPL_TOKEN_PROGRAM, 2, ["a", "b", "c"])],
      failed: false,
    });
    expect(analysis.verdict).toBe("warning");
    expect(analysis.effects[0].text).toContain("does not fully analyze");
  });
});

describe("analyzeLeftBehind system and unknown programs", () => {
  it("warns on an account being reassigned to a program", () => {
    const program = Keypair.generate().publicKey;
    const analysis = analyzeLeftBehind({
      instructions: [
        {
          programId: SYSTEM_PROGRAM,
          accountPubkeys: ["acct"],
          data: new Uint8Array([1, 0, 0, 0, ...program.toBytes()]),
        },
      ],
      failed: false,
    });
    expect(analysis.verdict).toBe("warning");
    expect(analysis.effects[0].text).toContain(program.toBase58());
    expect(analysis.effects[0].text).toContain("reassigned");
  });

  it("lists a created account as an ending-or-creation, not a grant", () => {
    const owner = Keypair.generate().publicKey;
    const data = new Uint8Array(52);
    new DataView(data.buffer).setUint32(0, 0, true);
    new DataView(data.buffer).setBigUint64(4, 2_039_280n, true);
    new DataView(data.buffer).setBigUint64(12, 165n, true);
    data.set(owner.toBytes(), 20);
    const analysis = analyzeLeftBehind({
      instructions: [
        { programId: SYSTEM_PROGRAM, accountPubkeys: ["from", "new"], data },
      ],
      failed: false,
    });
    expect(analysis.verdict).toBe("normal");
    expect(analysis.effects[0].severity).toBe("info");
    expect(analysis.effects[0].text).toContain(owner.toBase58());
  });

  it("warns on any unknown program, naming it", () => {
    const analysis = analyzeLeftBehind({
      instructions: [
        { programId: LIGHTHOUSE, accountPubkeys: ["x"], data: new Uint8Array([1]) },
      ],
      failed: false,
    });
    expect(analysis.verdict).toBe("warning");
    expect(analysis.effects[0].text).toContain(LIGHTHOUSE);
    expect(analysis.effects[0].text).toContain("cannot analyze");
  });
});

describe("analyzeLeftBehind against real library-built instructions", () => {
  it("analyzes an approve built by the shipped spl-token library through the real wire", () => {
    const source = Keypair.generate().publicKey;
    const delegate = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const { raw } = buildLegacyRaw([
      createApproveInstruction(source, delegate, owner, 500n),
    ]);
    const decoded = decodeRawTransaction(raw)!;
    const analysis = analyzeLeftBehind({
      instructions: decoded.instructions,
      failed: raw.meta?.err != null,
    });
    expect(analysis.verdict).toBe("warning");
    expect(analysis.effects).toHaveLength(1);
    expect(analysis.effects[0].text).toContain(delegate.toBase58());
    expect(analysis.effects[0].text).toContain("500 base units");
  });

  it("flags the danger shape built by the library: owner authority to a new address", () => {
    const account = Keypair.generate().publicKey;
    const current = Keypair.generate().publicKey;
    const attacker = Keypair.generate().publicKey;
    const { raw } = buildLegacyRaw([
      createSetAuthorityInstruction(
        account,
        current,
        AuthorityType.AccountOwner,
        attacker,
        []
      ),
    ]);
    const decoded = decodeRawTransaction(raw)!;
    const analysis = analyzeLeftBehind({
      instructions: decoded.instructions,
      failed: false,
    });
    expect(analysis.verdict).toBe("danger");
    expect(analysis.effects[0].text).toContain(attacker.toBase58());
  });

  it("analyzes a revoke and close built by the library", () => {
    const account = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const { raw } = buildLegacyRaw([
      createRevokeInstruction(account, owner),
      createCloseAccountInstruction(account, destination, owner),
    ]);
    const decoded = decodeRawTransaction(raw)!;
    const analysis = analyzeLeftBehind({
      instructions: decoded.instructions,
      failed: false,
    });
    expect(analysis.verdict).toBe("normal");
    expect(analysis.effects).toHaveLength(2);
    expect(analysis.effects.every((e) => e.severity === "info")).toBe(true);
    expect(analysis.headline).toContain("granted no new permissions");
  });

  it("reads the failed flag from the raw response shape (a failed tx left nothing)", () => {
    const { raw } = buildLegacyRaw(
      [createRevokeInstruction(Keypair.generate().publicKey, Keypair.generate().publicKey)],
      { err: { InstructionError: [0, { Custom: 1 }] } }
    );
    expect(raw.meta?.err != null).toBe(true);
    const decoded = decodeRawTransaction(raw)!;
    const analysis = analyzeLeftBehind({
      instructions: decoded.instructions,
      failed: raw.meta?.err != null,
    });
    expect(analysis.verdict).toBe("failed");
  });
});
