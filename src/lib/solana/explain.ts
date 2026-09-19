/**
 * Plain-language explanations of decoded transaction instructions.
 *
 * This is the UNDERSTAND analyzer's first slice (M2): given the output of
 * feeLedger's decodeRawTransaction (program id, resolved account pubkeys,
 * raw data bytes per instruction), produce one honest sentence per
 * instruction. The module is pure: no React, no fetch, no network. A
 * later slice adds its own signature fetcher and the /understand page.
 *
 * Honesty rules (product-level, owner-locked):
 * - A program outside the registry renders as "cannot describe", never a
 *   guess. Understatement is the worst failure mode for a safety tool.
 * - A known program with data this module does not decode renders as an
 *   honest "does not recognize" line naming the program.
 * - No verdicts here: descriptions of what an instruction does, never
 *   accusations. Nothing in this module ever builds or signs a
 *   transaction; UNDERSTAND is read-only forever.
 */

import type { DecodedInstruction } from "./feeLedger";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./tokenAccounts";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
const SPL_TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();

const PROGRAM_LABELS: Record<string, string> = {
  [SPL_TOKEN]: "the classic token program",
  [TOKEN_2022]: "the Token-2022 program",
  [SYSTEM_PROGRAM_ID]: "the System program",
  [COMPUTE_BUDGET_PROGRAM_ID]: "the compute budget program",
};

/* Wire tags this slice decodes. Everything else in a known program is an
 * honest unknown-instruction until a later slice adds it with fixtures. */
const SYSTEM_TRANSFER_TAG = 2;
const TOKEN_CLOSE_ACCOUNT_TAG = 9;

/** Why an instruction has no full explanation. Null means fully decoded. */
export type InstructionLimitation =
  | "unknown-program"
  | "unknown-instruction"
  | null;

export type ExplainedInstruction = {
  /** One plain-language sentence describing the instruction. */
  text: string;
  /** Null when the program and instruction were both fully decoded. */
  limitation: InstructionLimitation;
};

export type ExplainedTransaction = {
  blockTime: number | null;
  instructions: ExplainedInstruction[];
};

/** Lamports to SOL as an exact decimal string (no float rounding). */
function formatLamports(lamports: bigint): string {
  const sol = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0");
  const fracTrimmed = frac.replace(/0+$/, "");
  return fracTrimmed ? `${sol}.${fracTrimmed}` : `${sol}`;
}

function readU32LE(data: Uint8Array): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
    0,
    true
  );
}

function readU64LE(data: Uint8Array): bigint {
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength
  ).getBigUint64(0, true);
}

function cannotDescribeProgram(programId: string): ExplainedInstruction {
  return {
    text: `This tool cannot describe what program ${programId} does here.`,
    limitation: "unknown-program",
  };
}

function unrecognizedInstruction(label: string): ExplainedInstruction {
  return {
    text: `An instruction from ${label} that this tool does not recognize.`,
    limitation: "unknown-instruction",
  };
}

function explainSystemInstruction(
  instruction: DecodedInstruction
): ExplainedInstruction {
  const { data, accountPubkeys } = instruction;
  if (
    data.byteLength >= 12 &&
    readU32LE(data) === SYSTEM_TRANSFER_TAG &&
    accountPubkeys.length >= 2
  ) {
    const lamports = readU64LE(data.subarray(4));
    return {
      text: `Transfer ${formatLamports(lamports)} SOL from ${accountPubkeys[0]} to ${accountPubkeys[1]}.`,
      limitation: null,
    };
  }
  return unrecognizedInstruction(PROGRAM_LABELS[SYSTEM_PROGRAM_ID]);
}

function explainTokenInstruction(
  instruction: DecodedInstruction,
  label: string
): ExplainedInstruction {
  const { data, accountPubkeys } = instruction;
  if (
    data.byteLength === 1 &&
    data[0] === TOKEN_CLOSE_ACCOUNT_TAG &&
    accountPubkeys.length >= 2
  ) {
    return {
      text: `Close the token account ${accountPubkeys[0]} (${label}), sending its SOL to ${accountPubkeys[1]}. Only the account owner or its close authority can do this.`,
      limitation: null,
    };
  }
  return unrecognizedInstruction(label);
}

/** Explain one decoded instruction. Never throws: anything unresolvable
 *  degrades to an honest limitation line. */
export function explainInstruction(
  instruction: DecodedInstruction
): ExplainedInstruction {
  const label = PROGRAM_LABELS[instruction.programId];
  if (!label) return cannotDescribeProgram(instruction.programId);
  if (instruction.programId === SYSTEM_PROGRAM_ID) {
    return explainSystemInstruction(instruction);
  }
  if (
    instruction.programId === SPL_TOKEN ||
    instruction.programId === TOKEN_2022
  ) {
    return explainTokenInstruction(instruction, label);
  }
  return unrecognizedInstruction(label);
}

/** Explain every instruction of a decoded transaction, in wire order. */
export function explainDecodedTransaction(decoded: {
  blockTime: number | null;
  instructions: DecodedInstruction[];
  accountKeys: string[];
}): ExplainedTransaction {
  return {
    blockTime: decoded.blockTime,
    instructions: decoded.instructions.map(explainInstruction),
  };
}
