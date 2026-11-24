/**
 * Decoder-to-facts mapping tests (auditor round 4, 2026-11-24): every
 * instruction kind in the unified value-moving enumeration, decoded
 * through each REAL path - the app's raw-wire decode (feeLedger.ts),
 * the bell's decodeIx + ixFacts, and the counter's parsed shapes -
 * asserting the facts each decoder actually produces. The helper pins
 * in feeVerdictArms.test.ts test verdicts on SUPPLIED facts; this file
 * pins the decoders themselves, so a shape one decoder forgets (the
 * counter's transferWithSeed gap the auditor caught) fails here.
 *
 * The facts table below is the single source of truth for all three
 * paths; every row is asserted identically against every decoder. The
 * three implementations may differ in decoding but never in verdict -
 * nor in facts.
 */

import bs58 from "bs58";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { buildLegacyRaw, FEE_WALLET } from "./fixtures/rawTransactions";

import {
  decodeRawTransaction,
  isInboundFeeTransferInstruction,
  isValueMovingInstruction,
} from "@/lib/solana/feeLedger";

import {
  decodeIx,
  ixFacts,
  parsedInstructionFacts,
} from "../scripts/fee-wire-facts.mjs";

import { feeRowStructureConforms } from "../scripts/fee-verdict-arms.mjs";

const FEE = new PublicKey(FEE_WALLET);
const K = () => Keypair.generate().publicKey;
const SYSTEM = SystemProgram.programId.toBase58();
const MPL = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/** CreateAccountAllowPrefund, hand-rolled: SIMD-0312 (status
 *  Activated; mainnet 2026-05-29, Agave 4.0 cycle) gives it
 *  discriminant 13 with CreateAccount's data layout (u32 tag + u64
 *  lamports + u64 space + Pubkey owner = 52 bytes) and an OPTIONAL
 *  funding account at index 1, required only when lamports > 0 - it
 *  transfers those lamports to the new account. The installed
 *  @solana/web3.js 1.99.0 does not know this instruction (zero
 *  AllowPrefund references). */
function allowPrefund(lamports: number): TransactionInstruction {
  const data = Buffer.alloc(52);
  data.writeUInt32LE(13, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);
  data.writeBigUInt64LE(BigInt(165), 12);
  Buffer.from(K().toBytes()).copy(data, 20);
  return new TransactionInstruction({
    keys: [
      { pubkey: K(), isSigner: true, isWritable: true },
      { pubkey: K(), isSigner: true, isWritable: true },
    ],
    programId: SystemProgram.programId,
    data,
  });
}

function tokenIx(programId: PublicKey, data: Buffer): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: K(), isSigner: false, isWritable: true },
      { pubkey: K(), isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

function burnNft(): TransactionInstruction {
  return new TransactionInstruction({
    keys: [0, 1, 2, 3, 4].map(() => ({
      pubkey: K(),
      isSigner: false,
      isWritable: true,
    })),
    programId: new PublicKey(MPL),
    data: Buffer.from([29]),
  });
}

/** Real wire instructions, one per unified-set kind. */
function wireIxs(): Record<string, TransactionInstruction> {
  return {
    "transfer-into-fee": SystemProgram.transfer({
      fromPubkey: K(),
      toPubkey: FEE,
      lamports: 20_392,
    }),
    "transfer-elsewhere": SystemProgram.transfer({
      fromPubkey: K(),
      toPubkey: K(),
      lamports: 1,
    }),
    "transferWithSeed-into-fee": SystemProgram.transfer({
      fromPubkey: K(),
      basePubkey: K(),
      seed: "s",
      toPubkey: FEE,
      lamports: 20_392,
      programId: SystemProgram.programId,
    }),
    "transferWithSeed-elsewhere": SystemProgram.transfer({
      fromPubkey: K(),
      basePubkey: K(),
      seed: "s",
      toPubkey: K(),
      lamports: 1,
      programId: SystemProgram.programId,
    }),
    createAccount: SystemProgram.createAccount({
      fromPubkey: K(),
      newAccountPubkey: K(),
      lamports: 1_000_000,
      space: 165,
      programId: SystemProgram.programId,
    }),
    createAccountWithSeed: SystemProgram.createAccountWithSeed({
      fromPubkey: K(),
      basePubkey: K(),
      seed: "s",
      newAccountPubkey: K(),
      lamports: 1_000_000,
      space: 165,
      programId: SystemProgram.programId,
    }),
    "createAccountAllowPrefund-funded": allowPrefund(1_000_000),
    "createAccountAllowPrefund-unfunded": allowPrefund(0),
    withdrawNonceAccount: SystemProgram.nonceWithdraw({
      noncePubkey: K(),
      authorizedPubkey: K(),
      toPubkey: K(),
      lamports: 1_000_000,
    }),
    initializeNonceAccount: SystemProgram.nonceInitialize({
      noncePubkey: K(),
      authorizedPubkey: K(),
    }),
    advanceNonceAccount: SystemProgram.nonceAdvance({
      noncePubkey: K(),
      authorizedPubkey: K(),
    }),
    authorizeNonceAccount: SystemProgram.nonceAuthorize({
      noncePubkey: K(),
      authorizedPubkey: K(),
      newAuthorizedPubkey: K(),
    }),
    "spl-close": tokenIx(TOKEN_PROGRAM_ID, Buffer.from([9])),
    "t22-close": tokenIx(TOKEN_2022_PROGRAM_ID, Buffer.from([9])),
    "spl-burn": tokenIx(TOKEN_PROGRAM_ID, Buffer.from([8, 1, 0, 0, 0, 0, 0, 0, 0])),
    "t22-burnChecked": tokenIx(
      TOKEN_2022_PROGRAM_ID,
      Buffer.from([15, 1, 0, 0, 0, 0, 0, 0, 0, 9])
    ),
    "mpl-burnNft": burnNft(),
  };
}

/** THE facts table - the single source of truth, asserted against
 *  every decoder. [isInboundFeeTransfer, isValueMoving]. Tag 6
 *  (InitializeNonceAccount) is value-moving by the owner's DELIBERATE
 *  prohibition (stricter than value-inertness requires: the
 *  instruction initializes nonce state and transfers no lamports);
 *  tag 13 is value-moving unconditionally, including its unfunded
 *  (lamports 0) variant, by choice, on the stricter side. */
const FACTS: Record<string, [boolean, boolean]> = {
  "transfer-into-fee": [true, true],
  "transfer-elsewhere": [false, true],
  "transferWithSeed-into-fee": [true, true],
  "transferWithSeed-elsewhere": [false, true],
  createAccount: [false, true],
  createAccountWithSeed: [false, true],
  "createAccountAllowPrefund-funded": [false, true],
  "createAccountAllowPrefund-unfunded": [false, true],
  withdrawNonceAccount: [false, true],
  initializeNonceAccount: [false, true],
  advanceNonceAccount: [false, false],
  authorizeNonceAccount: [false, false],
  "spl-close": [false, true],
  "t22-close": [false, true],
  "spl-burn": [false, true],
  "t22-burnChecked": [false, true],
  "mpl-burnNft": [false, true],
};

describe("the app's raw-wire decode produces the unified facts", () => {
  it("every instruction kind decodes to exactly the facts in the table", () => {
    const wires = wireIxs();
    for (const [kind, ix] of Object.entries(wires)) {
      const { raw } = buildLegacyRaw([ix]);
      const decoded = decodeRawTransaction(raw);
      expect(decoded, kind).not.toBeNull();
      const outer = decoded!.instructions.slice(0, decoded!.outerInstructionCount);
      expect(outer, kind).toHaveLength(1);
      expect(isInboundFeeTransferInstruction(outer[0], FEE_WALLET), kind).toBe(
        FACTS[kind][0]
      );
      expect(isValueMovingInstruction(outer[0]), kind).toBe(FACTS[kind][1]);
    }
  });
});

describe("the bell's decodeIx + ixFacts produce the same facts", () => {
  /** Map a real instruction into the getTransaction JSON shape the
   *  bell actually decodes: program/account indexes into accountKeys,
   *  data as base58. */
  function toRpc(ix: TransactionInstruction): {
    keys: string[];
    rpc: { programIdIndex: number; accounts: number[]; data: string };
  } {
    const keys: string[] = [];
    const push = (p: PublicKey) => {
      const s = p.toBase58();
      if (!keys.includes(s)) keys.push(s);
      return keys.indexOf(s);
    };
    const programIdIndex = push(ix.programId);
    const accounts = ix.keys.map((k) => push(k.pubkey));
    return {
      keys,
      rpc: { programIdIndex, accounts, data: bs58.encode(ix.data) },
    };
  }

  it("every instruction kind decodes to exactly the facts in the table", () => {
    const wires = wireIxs();
    for (const [kind, ix] of Object.entries(wires)) {
      const { keys, rpc } = toRpc(ix);
      const decoded = decodeIx(rpc, keys);
      expect(decoded, kind).not.toBeNull();
      const facts = ixFacts(decoded!, FEE_WALLET);
      expect(facts.isInboundFeeTransfer, kind).toBe(FACTS[kind][0]);
      expect(facts.isValueMoving, kind).toBe(FACTS[kind][1]);
    }
  });
});

describe("the counter's parsed shapes produce the same facts", () => {
  /** The parsed instruction shapes the RPC parser actually emits
   *  (field names verified verbatim from anza-xyz/agave
   *  transaction-status/src/parse_system.rs and parse_token.rs). */
  function parsedIxs(): Record<string, Record<string, unknown>> {
    const a = K().toBase58();
    const b = K().toBase58();
    return {
      "transfer-into-fee": {
        programId: SYSTEM,
        parsed: { type: "transfer", info: { source: a, destination: FEE_WALLET, lamports: 20392 } },
      },
      "transfer-elsewhere": {
        programId: SYSTEM,
        parsed: { type: "transfer", info: { source: a, destination: b, lamports: 1 } },
      },
      "transferWithSeed-into-fee": {
        programId: SYSTEM,
        parsed: {
          type: "transferWithSeed",
          info: {
            source: a,
            sourceBase: b,
            destination: FEE_WALLET,
            lamports: 20392,
            sourceSeed: "s",
            sourceOwner: a,
          },
        },
      },
      "transferWithSeed-elsewhere": {
        programId: SYSTEM,
        parsed: {
          type: "transferWithSeed",
          info: {
            source: a,
            sourceBase: b,
            destination: b,
            lamports: 1,
            sourceSeed: "s",
            sourceOwner: a,
          },
        },
      },
      createAccount: {
        programId: SYSTEM,
        parsed: { type: "createAccount", info: { source: a, newAccount: b, lamports: 1000, space: 165, owner: a } },
      },
      createAccountWithSeed: {
        programId: SYSTEM,
        parsed: { type: "createAccountWithSeed", info: { source: a, newAccount: b, base: a, seed: "s", lamports: 1000, space: 165, owner: a } },
      },
      "createAccountAllowPrefund-funded": {
        programId: SYSTEM,
        parsed: { type: "createAccountAllowPrefund", info: { newAccount: a, source: b, lamports: 1000, space: 165, owner: a } },
      },
      "createAccountAllowPrefund-unfunded": {
        programId: SYSTEM,
        // The parser OMITS lamports entirely when it is zero
        // (agave parse_system.rs, the lamports == 0 branch).
        parsed: { type: "createAccountAllowPrefund", info: { newAccount: a, space: 165, owner: a } },
      },
      withdrawNonceAccount: {
        programId: SYSTEM,
        parsed: { type: "withdrawFromNonce", info: { nonceAccount: a, destination: b, recentBlockhashesSysvar: a, rentSysvar: a, nonceAuthority: b, lamports: 1000 } },
      },
      initializeNonceAccount: {
        programId: SYSTEM,
        parsed: { type: "initializeNonce", info: { nonceAccount: a, recentBlockhashesSysvar: b, rentSysvar: a, nonceAuthority: b } },
      },
      advanceNonceAccount: {
        programId: SYSTEM,
        parsed: { type: "advanceNonce", info: { nonceAccount: a, recentBlockhashesSysvar: b, nonceAuthority: a } },
      },
      authorizeNonceAccount: {
        programId: SYSTEM,
        parsed: { type: "authorizeNonce", info: { nonceAccount: a, nonceAuthority: a, newAuthorized: b } },
      },
      "spl-close": {
        programId: TOKEN_PROGRAM_ID.toBase58(),
        parsed: { type: "closeAccount", info: { account: a, destination: b, owner: a } },
      },
      "t22-close": {
        programId: TOKEN_2022_PROGRAM_ID.toBase58(),
        parsed: { type: "closeAccount", info: { account: a, destination: b, owner: a } },
      },
      "spl-burn": {
        programId: TOKEN_PROGRAM_ID.toBase58(),
        parsed: { type: "burn", info: { account: a, mint: b, amount: "1000" } },
      },
      "t22-burnChecked": {
        programId: TOKEN_2022_PROGRAM_ID.toBase58(),
        parsed: { type: "burnChecked", info: { account: a, mint: b, amount: "1000", decimals: 6 } },
      },
      "mpl-burnNft": {
        programId: MPL,
        data: bs58.encode(Buffer.from([29])),
        accounts: [a, b, a, b, a],
      },
    };
  }

  it("every parsed shape maps to exactly the facts in the table", () => {
    const ixs = parsedIxs();
    for (const [kind, ix] of Object.entries(ixs)) {
      const facts = parsedInstructionFacts(ix, FEE_WALLET);
      expect(facts.isInboundFeeTransfer, kind).toBe(FACTS[kind][0]);
      expect(facts.isValueMoving, kind).toBe(FACTS[kind][1]);
    }
  });
});

describe("round-4 gap chains through the REAL counter facts", () => {
  it("a transferWithSeed INTO the fee wallet counts as the fee (facts -> structure)", () => {
    const ixs = parsedIxsOfCounter();
    // close, transferWithSeed into the fee wallet: one inbound
    // fee-transfer instruction, nothing value-moving after it.
    const facts = [
      parsedInstructionFacts(ixs.close, FEE_WALLET),
      parsedInstructionFacts(ixs.seedIntoFee, FEE_WALLET),
    ];
    expect(facts[1].isInboundFeeTransfer).toBe(true);
    expect(feeRowStructureConforms(facts)).toBe(true);
  });

  it("a transferWithSeed to another destination after the fee FAILS structure (facts -> structure)", () => {
    const ixs = parsedIxsOfCounter();
    const facts = [
      parsedInstructionFacts(ixs.close, FEE_WALLET),
      parsedInstructionFacts(ixs.transferIntoFee, FEE_WALLET),
      parsedInstructionFacts(ixs.seedElsewhere, FEE_WALLET),
    ];
    expect(facts[2].isValueMoving).toBe(true);
    expect(feeRowStructureConforms(facts)).toBe(false);
  });

  // Local re-declaration so the chains use the same real shapes as the
  // table suite above without re-running its loops.
  function parsedIxsOfCounter(): {
    close: Record<string, unknown>;
    transferIntoFee: Record<string, unknown>;
    seedIntoFee: Record<string, unknown>;
    seedElsewhere: Record<string, unknown>;
  } {
    const a = K().toBase58();
    const b = K().toBase58();
    return {
      close: {
        programId: TOKEN_PROGRAM_ID.toBase58(),
        parsed: { type: "closeAccount", info: { account: a, destination: b, owner: a } },
      },
      transferIntoFee: {
        programId: SYSTEM,
        parsed: { type: "transfer", info: { source: a, destination: FEE_WALLET, lamports: 20392 } },
      },
      seedIntoFee: {
        programId: SYSTEM,
        parsed: {
          type: "transferWithSeed",
          info: {
            source: a,
            sourceBase: b,
            destination: FEE_WALLET,
            lamports: 20392,
            sourceSeed: "s",
            sourceOwner: a,
          },
        },
      },
      seedElsewhere: {
        programId: SYSTEM,
        parsed: {
          type: "transferWithSeed",
          info: {
            source: a,
            sourceBase: b,
            destination: b,
            lamports: 1,
            sourceSeed: "s",
            sourceOwner: a,
          },
        },
      },
    };
  }
});
