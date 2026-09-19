import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  explainDecodedTransaction,
  explainInstruction,
} from "@/lib/solana/explain";
import { decodeRawTransaction } from "@/lib/solana/feeLedger";
import {
  buildLegacyRaw,
  buildV0LoadedAddressesRaw,
  buildV1RepairRaw,
  closeIx,
  FEE_WALLET,
  realV1Raw,
  REAL_V1_BLOCK_TIME,
  systemTransfer as systemTransferIx,
} from "./fixtures/rawTransactions";
import type { DecodedInstruction } from "@/lib/solana/feeLedger";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@/lib/solana/tokenAccounts";

/* Synthetic but well-formed addresses; never parsed, only echoed. */
const OWNER = "OwnerGoKfWgbarzvZufmPcHrB2LTNaCGPmHztT8cVCXmAkGCobqjATx";
const DESTINATION = "Dest4dRkBVcNtCkVBz6CJzgN8NW9XP8ycTmvzdnwYxQHZvj5SJe";
const TOKEN_ACCOUNT =
  "ToknAcctFake9VtCUqmtexyXYzoHqP2bWczm8VqVkMPXhTPwFTqAgREk5p";
/* A real program this tool deliberately does not model: the Lighthouse
 * assertion protocol (observed appending instructions to repair
 * transactions). It must render as an honest unknown, never a guess. */
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SPL_TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();

function systemTransfer(
  lamports: bigint,
  from: string,
  to: string
): DecodedInstruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return { programId: SYSTEM_PROGRAM, accountPubkeys: [from, to], data };
}

function closeAccount(
  programId: string,
  account: string,
  destination: string,
  owner: string
): DecodedInstruction {
  return {
    programId,
    accountPubkeys: [account, destination, owner],
    data: new Uint8Array([9]),
  };
}

/** Token-program wire shape: one tag byte, then the payload (u64 LE or
 *  nothing), exactly as the token programs serialize instructions. */
function tokenIx(
  programId: string,
  tag: number,
  accountPubkeys: string[],
  u64Payload?: bigint,
  extraBytes?: number[]
): DecodedInstruction {
  const data = new Uint8Array(
    u64Payload === undefined && extraBytes === undefined
      ? 1
      : 1 + (u64Payload === undefined ? 0 : 8) + (extraBytes?.length ?? 0)
  );
  data[0] = tag;
  if (u64Payload !== undefined) {
    new DataView(data.buffer).setBigUint64(1, u64Payload, true);
  }
  if (extraBytes) data.set(extraBytes, 1 + (u64Payload === undefined ? 0 : 8));
  return { programId, accountPubkeys, data };
}

const COMPUTE_BUDGET_PROGRAM =
  "ComputeBudget111111111111111111111111111111";

function computeIx(tag: number, payload: number[]): DecodedInstruction {
  return {
    programId: COMPUTE_BUDGET_PROGRAM,
    accountPubkeys: [],
    data: new Uint8Array([tag, ...payload]),
  };
}

describe("explainInstruction", () => {
  it("explains a system transfer with the amount and both addresses", () => {
    const result = explainInstruction(
      systemTransfer(5000n, OWNER, FEE_WALLET)
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Transfer 0.000005 SOL from ${OWNER} to ${FEE_WALLET}.`
    );
  });

  it("formats whole and fractional SOL without float error", () => {
    const result = explainInstruction(
      systemTransfer(2_039_280_000_000n, OWNER, DESTINATION)
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toContain("Transfer 2039.28 SOL");
  });

  it("explains a classic token program close with destination and owner", () => {
    const result = explainInstruction(
      closeAccount(SPL_TOKEN_PROGRAM, TOKEN_ACCOUNT, DESTINATION, OWNER)
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Close the token account ${TOKEN_ACCOUNT} (the classic token program), sending its SOL to ${DESTINATION}. Only the account owner or its close authority can do this.`
    );
  });

  it("explains a Token-2022 close with the same shape", () => {
    const result = explainInstruction(
      closeAccount(TOKEN_2022_PROGRAM, TOKEN_ACCOUNT, DESTINATION, OWNER)
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toContain("Token-2022");
  });

  it("says honestly when it cannot describe a program", () => {
    const result = explainInstruction({
      programId: LIGHTHOUSE,
      accountPubkeys: [OWNER],
      data: new Uint8Array([1, 2, 3]),
    });
    expect(result.limitation).toBe("unknown-program");
    expect(result.text).toBe(
      `This tool cannot describe what program ${LIGHTHOUSE} does here.`
    );
  });

  it("never throws on a known program with unexpected data", () => {
    const result = explainInstruction({
      programId: SYSTEM_PROGRAM,
      accountPubkeys: [OWNER, DESTINATION],
      data: new Uint8Array(0),
    });
    expect(result.limitation).toBe("unknown-instruction");
    expect(result.text).toContain("the System program");
    expect(result.text).toContain("does not recognize");
  });

  it("never throws on a token program instruction it does not decode", () => {
    const result = explainInstruction({
      programId: SPL_TOKEN_PROGRAM,
      accountPubkeys: [TOKEN_ACCOUNT, OWNER],
      data: new Uint8Array([200]),
    });
    expect(result.limitation).toBe("unknown-instruction");
    expect(result.text).toContain("classic token program");
  });
});

describe("explainInstruction token table", () => {
  it("explains a token transfer in base units", () => {
    const result = explainInstruction(
      tokenIx(SPL_TOKEN_PROGRAM, 3, [TOKEN_ACCOUNT, DESTINATION], 2500000000n)
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Transfer 2500000000 base units of the token in account ${TOKEN_ACCOUNT} to account ${DESTINATION}.`
    );
  });

  it("explains an approve (granting a delegate spending permission)", () => {
    const result = explainInstruction(
      tokenIx(SPL_TOKEN_PROGRAM, 4, [TOKEN_ACCOUNT, DESTINATION], 1000000n)
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Let ${DESTINATION} spend up to 1000000 base units from token account ${TOKEN_ACCOUNT}.`
    );
  });

  it("explains a revoke (removing a delegate), the instruction the repair uses", () => {
    const result = explainInstruction(
      tokenIx(SPL_TOKEN_PROGRAM, 5, [TOKEN_ACCOUNT, OWNER])
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Remove the delegate (all spending permission) from token account ${TOKEN_ACCOUNT}.`
    );
  });

  it("explains setting an authority to a new address, the dangerous class", () => {
    const newAuthority = Keypair.generate();
    const result = explainInstruction(
      tokenIx(SPL_TOKEN_PROGRAM, 6, [TOKEN_ACCOUNT, OWNER], undefined, [
        2,
        1,
        ...newAuthority.publicKey.toBytes(),
      ])
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Change the account owner authority of ${TOKEN_ACCOUNT} to ${newAuthority.publicKey.toBase58()}.`
    );
  });

  it("explains removing an authority (option byte 0)", () => {
    const result = explainInstruction(
      tokenIx(SPL_TOKEN_PROGRAM, 6, [TOKEN_ACCOUNT, OWNER], undefined, [
        3,
        0,
      ])
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Remove the close authority from ${TOKEN_ACCOUNT}.`
    );
  });

  it("explains an unknown authority type honestly rather than guessing", () => {
    const result = explainInstruction(
      tokenIx(SPL_TOKEN_PROGRAM, 6, [TOKEN_ACCOUNT, OWNER], undefined, [
        9,
        0,
      ])
    );
    expect(result.limitation).toBe("unknown-instruction");
  });

  it("explains minting new tokens", () => {
    const result = explainInstruction(
      tokenIx(SPL_TOKEN_PROGRAM, 7, [DESTINATION, TOKEN_ACCOUNT, OWNER], 500n)
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Create 500 new base units of the token mint ${DESTINATION} into account ${TOKEN_ACCOUNT}.`
    );
  });

  it("explains burning tokens", () => {
    const result = explainInstruction(
      tokenIx(TOKEN_2022_PROGRAM, 8, [TOKEN_ACCOUNT, OWNER], 100n)
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Destroy 100 base units in token account ${TOKEN_ACCOUNT}.`
    );
  });

  it("explains a checked transfer with the mint and decimals", () => {
    // Wire order verified against the shipped @solana/spl-token encoder:
    // tag, u64 amount at offset 1, decimals byte last.
    const data = new Uint8Array(10);
    data[0] = 12;
    new DataView(data.buffer).setBigUint64(1, 42n, true);
    data[9] = 6;
    const result = explainInstruction({
      programId: SPL_TOKEN_PROGRAM,
      accountPubkeys: [TOKEN_ACCOUNT, DESTINATION, OWNER],
      data,
    });
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Transfer 42 base units (6 decimals) of mint ${DESTINATION} from account ${TOKEN_ACCOUNT} to account ${OWNER}.`
    );
  });

  it("explains freezing an account", () => {
    const result = explainInstruction(
      tokenIx(TOKEN_2022_PROGRAM, 10, [TOKEN_ACCOUNT, OWNER])
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      `Freeze token account ${TOKEN_ACCOUNT}. Only its freeze authority can do this, and a frozen account cannot send or receive tokens.`
    );
  });

  it("falls back honestly when a known tag arrives with too few accounts", () => {
    const result = explainInstruction(
      tokenIx(SPL_TOKEN_PROGRAM, 3, [TOKEN_ACCOUNT], 1n)
    );
    expect(result.limitation).toBe("unknown-instruction");
  });
});

describe("explainInstruction compute budget", () => {
  it("explains a compute unit price offer", () => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, 375000n, true);
    const result = explainInstruction(computeIx(3, Array.from(bytes)));
    expect(result.limitation).toBeNull();
    expect(result.text).toBe(
      "Offer a priority fee of 375000 micro-lamports per compute unit."
    );
  });

  it("explains a compute unit limit", () => {
    const result = explainInstruction(
      computeIx(2, [0x40, 0x0d, 0x03, 0x00])
    );
    expect(result.limitation).toBeNull();
    expect(result.text).toBe("Set the compute unit limit to 200000.");
  });

  it("says honestly when it cannot decode a compute budget instruction", () => {
    const result = explainInstruction(computeIx(0x16, [1, 2, 3, 4]));
    expect(result.limitation).toBe("unknown-instruction");
    expect(result.text).toContain("compute budget");
  });
});

describe("explainDecodedTransaction over real and shared wire bytes", () => {
  it("explains the real devnet v1 transaction as an honest unknown", () => {
    const decoded = decodeRawTransaction(realV1Raw());
    expect(decoded).not.toBeNull();
    const explained = explainDecodedTransaction(decoded!);
    expect(explained.blockTime).toBe(REAL_V1_BLOCK_TIME);
    expect(explained.instructions).toHaveLength(1);
    expect(explained.instructions[0].limitation).toBe("unknown-program");
    expect(explained.instructions[0].text).toContain("cannot describe");
  });

  it("explains a legacy repair end to end (closes and the fee transfer)", () => {
    const { raw } = buildLegacyRaw([
      closeIx(),
      closeIx("token-2022"),
      systemTransferIx(new PublicKey(FEE_WALLET), 20_392),
    ]);
    const decoded = decodeRawTransaction(raw);
    expect(decoded).not.toBeNull();
    const explained = explainDecodedTransaction(decoded!);
    expect(explained.instructions).toHaveLength(3);
    expect(explained.instructions[0].text).toContain("Close the token account");
    expect(explained.instructions[0].text).toContain("classic token program");
    expect(explained.instructions[1].text).toContain("Token-2022");
    const transfer = explained.instructions[2];
    expect(transfer.limitation).toBeNull();
    expect(transfer.text).toContain("0.000020392 SOL");
    expect(transfer.text).toContain(FEE_WALLET);
  });

  it("explains a hand-built v1 repair (close and fee transfer)", () => {
    const raw = buildV1RepairRaw({ feeLamports: 20_392 });
    const decoded = decodeRawTransaction(raw);
    expect(decoded).not.toBeNull();
    const explained = explainDecodedTransaction(decoded!);
    expect(explained.instructions).toHaveLength(2);
    expect(explained.instructions[0].text).toContain("Close the token account");
    const transfer = explained.instructions[1];
    expect(transfer.limitation).toBeNull();
    expect(transfer.text).toContain("0.000020392 SOL");
    expect(transfer.text).toContain(FEE_WALLET);
  });

  it("names accounts that exist only through address lookup tables", () => {
    const { raw, loadedAccount, loadedDestination } =
      buildV0LoadedAddressesRaw();
    const decoded = decodeRawTransaction(raw);
    expect(decoded).not.toBeNull();
    const explained = explainDecodedTransaction(decoded!);
    expect(explained.instructions).toHaveLength(1);
    const line = explained.instructions[0];
    expect(line.limitation).toBeNull();
    expect(line.text).toContain("Close the token account");
    expect(line.text).toContain(loadedAccount);
    expect(line.text).toContain(loadedDestination);
  });
});

describe("explainDecodedTransaction", () => {
  it("explains every instruction in order and carries the block time", () => {
    const result = explainDecodedTransaction({
      blockTime: 1789215763,
      instructions: [
        closeAccount(SPL_TOKEN_PROGRAM, TOKEN_ACCOUNT, DESTINATION, OWNER),
        systemTransfer(30276n, OWNER, FEE_WALLET),
      ],
      accountKeys: [OWNER, DESTINATION, TOKEN_ACCOUNT, FEE_WALLET],
    });
    expect(result.blockTime).toBe(1789215763);
    expect(result.instructions).toHaveLength(2);
    expect(result.instructions[0].text).toContain("Close the token account");
    expect(result.instructions[1].text).toContain("0.000030276 SOL");
    expect(result.instructions[1].text).toContain(FEE_WALLET);
  });
});
