import { describe, expect, it } from "vitest";
import {
  explainDecodedTransaction,
  explainInstruction,
} from "@/lib/solana/explain";
import type { DecodedInstruction } from "@/lib/solana/feeLedger";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@/lib/solana/tokenAccounts";

/* Synthetic but well-formed addresses; never parsed, only echoed. */
const OWNER = "OwnerGoKfWgbarzvZufmPcHrB2LTNaCGPmHztT8cVCXmAkGCobqjATx";
const DESTINATION = "Dest4dRkBVcNtCkVBz6CJzgN8NW9XP8ycTmvzdnwYxQHZvj5SJe";
const FEE_WALLET = "6qhajWTtUKadkMaumpADGBkmPkASiwXRqGtqd8ypL74K";
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
