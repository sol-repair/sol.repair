/**
 * Post-state capability analysis (UNDERSTAND, M3).
 *
 * M2 explains what each instruction did. This module answers the question
 * that protects people: what did the transaction LEAVE BEHIND? Standing
 * spending permissions, authority handovers, frozen accounts, ended
 * powers. The lens is capabilities, not balances: moving SOL is a
 * today-event; granting someone lasting control is a tomorrow problem.
 *
 * Owner-locked rules, enforced by tests:
 * - Three outcome verdicts: normal / warning / danger, with a separate
 *   "failed" state because a failed transaction changed nothing.
 * - Danger is reserved for exactly one shape: handing owner-level control
 *   of a token account to a different address. Everything else is stated
 *   plainly as a warning with the facts; the tool describes, never
 *   accuses, and the words scam, safe, and guaranteed never appear.
 * - Unknown programs force at least a warning: what cannot be analyzed
 *   cannot be cleared. The single documented exception is the compute
 *   budget program, whose instructions can only configure this
 *   transaction's fees and limits and can never touch account state.
 * - Actor-agnostic wording until the wallet-connected milestone: addresses
 *   are named, never assumed to be "you".
 */

import bs58 from "bs58";

import type { DecodedInstruction } from "./feeLedger";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./tokenAccounts";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SPL_TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();

const TOKEN_INITIALIZE_MINT_TAG = 0;
const TOKEN_INITIALIZE_ACCOUNT_TAG = 1;
const TOKEN_APPROVE_TAG = 4;
const TOKEN_REVOKE_TAG = 5;
const TOKEN_SET_AUTHORITY_TAG = 6;
const TOKEN_CLOSE_ACCOUNT_TAG = 9;
const TOKEN_FREEZE_TAG = 10;
const TOKEN_INITIALIZE_ACCOUNT2_TAG = 16;
const TOKEN_SYNC_NATIVE_TAG = 17;
const TOKEN_INITIALIZE_ACCOUNT3_TAG = 18;
const TOKEN_INITIALIZE_MINT2_TAG = 20;
const TOKEN_GET_ACCOUNT_DATA_SIZE_TAG = 21;
const TOKEN_INITIALIZE_IMMUTABLE_OWNER_TAG = 22;
const TOKEN_THAW_TAG = 11;
const SYSTEM_CREATE_ACCOUNT_TAG = 0;
const SYSTEM_ASSIGN_TAG = 1;
const SYSTEM_TRANSFER_TAG = 2;
const SYSTEM_TRANSFER_WITH_SEED_TAG = 11;
const U64_MAX = 18_446_744_073_709_551_615n;

/* SetAuthority authority types shared by both token programs. */
const AUTHORITY_PHRASES: Record<number, string> = {
  0: "mint authority",
  1: "freeze authority",
  2: "account owner authority",
  3: "close authority",
};

const TOKEN_LABELS: Record<string, string> = {
  [SPL_TOKEN]: "the classic token program",
  [TOKEN_2022]: "the Token-2022 program",
};

/** One lasting change the transaction made. `severity` is per-effect;
 *  the transaction verdict is derived from the worst of them. */
export type CapabilityEffect = {
  text: string;
  severity: "info" | "warning" | "danger";
};

/** Internal: findings that carry a plural template merge with identical
 *  siblings into one counted line, so a wall of near-identical unknown
 *  sentences reads as a summary. Never exposed to the page. */
type Finding = CapabilityEffect & {
  groupPlural?: (count: number) => string;
};

export type LeftBehindVerdict =
  | "failed"
  | "normal"
  | "warning"
  | "danger";

export type LeftBehindAnalysis = {
  verdict: LeftBehindVerdict;
  headline: string;
  effects: CapabilityEffect[];
};

function readU64LE(data: Uint8Array): bigint {
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength
  ).getBigUint64(0, true);
}

/** Exact lamports-to-SOL string (no float rounding), same shape as the
 *  explainer's formatter. */
function formatSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : `${whole}`;
}

function unrecognized(label: string): Finding {
  return {
    severity: "warning",
    text: `An instruction from ${label} ran that this tool does not fully analyze. What it left behind is not known.`,
    groupPlural: (count) =>
      `${count} instructions from ${label} ran that this tool does not fully analyze. What they left behind is not known.`,
  };
}

function cannotAnalyzeProgram(programId: string): Finding {
  return {
    severity: "warning",
    text: `This tool cannot analyze program ${programId}. What this instruction left behind is not known.`,
    groupPlural: (count) =>
      `This tool cannot analyze ${count} instructions from program ${programId}. What they left behind is not known.`,
  };
}

function tokenEffect(ix: DecodedInstruction): Finding[] {
  const { data, accountPubkeys } = ix;
  const tag = data.byteLength >= 1 ? data[0] : -1;
  const u64At = (offset: number): bigint | null =>
    data.byteLength >= offset + 8 ? readU64LE(data.subarray(offset)) : null;

  if (tag === TOKEN_APPROVE_TAG && u64At(1) !== null && accountPubkeys.length >= 2) {
    const [source, delegate] = accountPubkeys;
    const amount = u64At(1)!;
    const scope =
      amount === U64_MAX ? "an unlimited amount" : `up to ${amount} base units`;
    return [
      {
        severity: "warning",
        text: `Address ${delegate} can now spend ${scope} from token account ${source}. This ends if the delegate is revoked.`,
      },
    ];
  }
  if (tag === TOKEN_REVOKE_TAG && accountPubkeys.length >= 1) {
    return [
      {
        severity: "info",
        text: `The delegate on token account ${accountPubkeys[0]} was removed. One standing permission ended.`,
      },
    ];
  }
  if (tag === TOKEN_SET_AUTHORITY_TAG && data.byteLength >= 3 && accountPubkeys.length >= 1) {
    const kind = AUTHORITY_PHRASES[data[1]];
    const account = accountPubkeys[0];
    const granting = data[2] === 1 && data.byteLength >= 35;
    const removing = data[2] === 0;
    if (!kind) {
      return [unrecognized(TOKEN_LABELS[ix.programId] ?? "the token program")];
    }
    if (granting) {
      const granted = bs58.encode(data.subarray(3, 35));
      // The one danger rule: a different address taking owner-level
      // control of a token account. Re-granting to the current holder is
      // a no-op and is stated as such.
      if (data[1] === 2 && granted !== accountPubkeys[1]) {
        return [
          {
            severity: "danger",
            text: `The account owner of token account ${account} is now ${granted}. If this was not intended, the previous owner may no longer control the tokens in it.`,
          },
        ];
      }
      if (data[1] === 2) {
        return [
          {
            severity: "info",
            text: `The account owner of token account ${account} remains ${granted}.`,
          },
        ];
      }
      const detail: Record<number, string> = {
        0: "They can create new units of this token.",
        1: "They can freeze token accounts of this mint.",
        3: "They can close the account and collect its SOL.",
      };
      const noun =
        data[1] === 3 ? `token account ${account}` : account;
      return [
        {
          severity: "warning",
          text: `The ${kind} of ${noun} is now ${granted}. ${detail[data[1]] ?? ""}`.trim(),
        },
      ];
    }
    if (removing) {
      return [
        {
          severity: "info",
          text: `The ${kind} was removed from ${account}.`,
        },
      ];
    }
    return [unrecognized(TOKEN_LABELS[ix.programId] ?? "the token program")];
  }
  if (tag === TOKEN_CLOSE_ACCOUNT_TAG && accountPubkeys.length >= 1) {
    return [
      {
        severity: "info",
        text: `Token account ${accountPubkeys[0]} was closed. Any permissions on it ended with the account.`,
      },
    ];
  }
  if (tag === TOKEN_FREEZE_TAG && accountPubkeys.length >= 1) {
    return [
      {
        severity: "warning",
        text: `Token account ${accountPubkeys[0]} is now frozen. It cannot send or receive tokens until the freeze authority thaws it.`,
      },
    ];
  }
  if (
    (tag === TOKEN_INITIALIZE_MINT_TAG || tag === TOKEN_INITIALIZE_MINT2_TAG) &&
    data.byteLength >= 35 &&
    accountPubkeys.length >= 1
  ) {
    const decimals = data[1];
    const authority = bs58.encode(data.subarray(2, 34));
    const freezeText =
      data[34] === 1 && data.byteLength >= 67
        ? ` Its freeze authority is ${bs58.encode(data.subarray(35, 67))}.`
        : "";
    return [
      {
        severity: "info",
        text: `A new token mint was set up with ${decimals} decimals. Its mint authority is ${authority}.${freezeText}`,
      },
    ];
  }
  if (tag === TOKEN_INITIALIZE_ACCOUNT_TAG && accountPubkeys.length >= 3) {
    const [account, mint, ownerKey] = accountPubkeys;
    return [
      {
        severity: "info",
        text: `Token account ${account} was set up for mint ${mint}, owned by ${ownerKey}.`,
      },
    ];
  }
  if (
    (tag === TOKEN_INITIALIZE_ACCOUNT2_TAG ||
      tag === TOKEN_INITIALIZE_ACCOUNT3_TAG) &&
    data.byteLength >= 33 &&
    accountPubkeys.length >= 2
  ) {
    const ownerKey = bs58.encode(data.subarray(1, 33));
    return [
      {
        severity: "info",
        text: `Token account ${accountPubkeys[0]} was set up for mint ${accountPubkeys[1]}, owned by ${ownerKey}.`,
      },
    ];
  }
  if (
    tag === TOKEN_INITIALIZE_IMMUTABLE_OWNER_TAG &&
    accountPubkeys.length >= 1
  ) {
    return [
      {
        severity: "info",
        text: `Token account ${accountPubkeys[0]} was marked so its owner can never be changed.`,
      },
    ];
  }
  if (tag === TOKEN_THAW_TAG && accountPubkeys.length >= 1) {
    return [
      {
        severity: "info",
        text: `Token account ${accountPubkeys[0]} was thawed. It can send and receive tokens again.`,
      },
    ];
  }
  // Transfers (3), mints (7), burns (8), checked transfers (12), the
  // space question (21), and the wrapped SOL sync (17) move or read
  // balances now and leave no standing capability behind.
  if (
    (tag === 3 ||
      tag === 7 ||
      tag === 8 ||
      tag === 12 ||
      tag === TOKEN_GET_ACCOUNT_DATA_SIZE_TAG ||
      tag === TOKEN_SYNC_NATIVE_TAG) &&
    accountPubkeys.length >= 1
  ) {
    return [];
  }
  return [unrecognized(TOKEN_LABELS[ix.programId] ?? "the token program")];
}

function systemEffect(ix: DecodedInstruction): Finding[] {
  const { data, accountPubkeys } = ix;
  if (data.byteLength >= 4) {
    const tag = new DataView(
      data.buffer,
      data.byteOffset,
      data.byteLength
    ).getUint32(0, true);
    if (tag === SYSTEM_TRANSFER_TAG || tag === SYSTEM_TRANSFER_WITH_SEED_TAG) {
      return [];
    }
    if (tag === SYSTEM_ASSIGN_TAG && data.byteLength >= 36 && accountPubkeys.length >= 1) {
      const program = bs58.encode(data.subarray(4, 36));
      return [
        {
          severity: "warning",
          text: `Account ${accountPubkeys[0]} was reassigned to program ${program}. Its contents are now governed by that program.`,
        },
      ];
    }
    if (tag === SYSTEM_CREATE_ACCOUNT_TAG && data.byteLength >= 52 && accountPubkeys.length >= 2) {
      const lamports = readU64LE(data.subarray(4));
      const owner = bs58.encode(data.subarray(20, 52));
      return [
        {
          severity: "info",
          text: `A new account ${accountPubkeys[1]} was created with ${formatSol(lamports)} SOL, owned by program ${owner}.`,
        },
      ];
    }
  }
  return [unrecognized("the System program")];
}

/** Analyze what a transaction left behind. Pure: no React, no fetch. */
export function analyzeLeftBehind(input: {
  instructions: DecodedInstruction[];
  /** True when the on-chain error field is set: a failed transaction
   *  changed nothing, and saying so beats analyzing what it tried. */
  failed: boolean;
}): LeftBehindAnalysis {
  if (input.failed) {
    return {
      verdict: "failed",
      headline:
        "This transaction failed on chain. It changed nothing: no balances moved and nothing was left behind.",
      effects: [],
    };
  }

  const findings: Finding[] = [];
  for (const ix of input.instructions) {
    if (ix.programId === COMPUTE_BUDGET_PROGRAM_ID) {
      // The documented exception: compute budget instructions configure
      // this transaction's fees and limits and cannot touch state.
      continue;
    }
    if (ix.programId === SYSTEM_PROGRAM_ID) {
      findings.push(...systemEffect(ix));
      continue;
    }
    if (ix.programId === SPL_TOKEN || ix.programId === TOKEN_2022) {
      findings.push(...tokenEffect(ix));
      continue;
    }
    if (ix.programId === ATA_PROGRAM_ID) {
      // The Associated Token Account program's own instructions carry no
      // capability of their own: the creates and setups they perform show
      // up as inner instructions and are analyzed there.
      const data = ix.data;
      const known =
        data.byteLength === 0 ||
        (data.byteLength === 1 && (data[0] === 1 || data[0] === 2));
      if (known) continue;
      findings.push(
        unrecognized("the Associated Token Account program")
      );
      continue;
    }
    findings.push(cannotAnalyzeProgram(ix.programId));
  }

  // Repeated unknown lines merge into one counted line so the panel reads
  // as a summary rather than a wall of near-identical sentences. The
  // headline still counts individual findings, never merged lines.
  const lines: { severity: CapabilityEffect["severity"]; singular: string }[] =
    [];
  const counts = new Map<string, number>();
  for (const finding of findings) {
    if (finding.groupPlural) {
      const seen = counts.get(finding.text);
      if (seen !== undefined) {
        counts.set(finding.text, seen + 1);
        continue;
      }
      counts.set(finding.text, 1);
    }
    lines.push({ severity: finding.severity, singular: finding.text });
  }
  const effects: CapabilityEffect[] = lines.map((line) => {
    const n = counts.get(line.singular) ?? 1;
    if (n === 1) return { severity: line.severity, text: line.singular };
    const template = findings.find(
      (f) => f.text === line.singular && f.groupPlural
    )?.groupPlural;
    return {
      severity: line.severity,
      text: template ? template(n) : line.singular,
    };
  });

  const verdict: LeftBehindVerdict = findings.some(
    (e) => e.severity === "danger"
  )
    ? "danger"
    : findings.some((e) => e.severity === "warning")
      ? "warning"
      : "normal";

  const count = findings.length;
  const plural = count === 1 ? "change" : "changes";
  let headline: string;
  if (verdict === "danger") {
    headline =
      "This transaction hands control of a token account to a different address. Read the details below.";
  } else if (verdict === "warning") {
    headline = `This transaction left ${count} lasting ${plural}. Read each one below.`;
  } else if (count > 0) {
    headline = `This transaction made ${count} lasting ${plural} and granted no new permissions.`;
  } else {
    headline =
      "This transaction left nothing behind. It only moved balances and paid fees.";
  }

  return { verdict, headline, effects };
}
