// Operator tooling, shared by the two fee-ledger scripts (the anomaly
// bell and the weekly recovered-totals walk): the raw-wire decoder,
// the raw-tag facts builder, and the parsed-shape facts builder.
//
// What is unified here and what deliberately is not: the scripts'
// independence from the PRODUCT (src/lib/solana/feeLedger.ts) is the
// point (see the header of check-fee-ledger.mjs), so the app's TS
// decode stays its own implementation. What the two SCRIPTS share
// between themselves is ONE decoding-and-facts module, the same
// shared-helper pattern owner decision 2026-11-22 installed for the
// verdict arithmetic (fee-verdict-arms.mjs), so the bell and the
// counter can never drift apart. The bell decodes RAW wires
// (getTransaction); the counter decodes PARSED shapes
// (getParsedTransaction) - different decoders by design, pinned to
// identical facts by tests/feeWireFacts.test.ts.
//
// THE ONE UNIFIED VALUE-MOVING DEFINITION (auditor round 3+4,
// 2026-11-24; the app ledger, the bell, and the counter may differ in
// decoding but never in verdict or facts). Every kind below is listed
// with its raw tag and the RPC parser's own parsed name:
//
// System program (tags verified against the installed
// @solana/web3.js 1.99.0 source, SYSTEM_INSTRUCTION_LAYOUTS in
// node_modules/@solana/web3.js/src/programs/system.ts; parsed names
// verified verbatim from anza-xyz/agave
// transaction-status/src/parse_system.rs):
//   0  Create                     "createAccount"             value-moving (funded creation)
//   1  Assign                     "assign"                    inert (no lamports)
//   2  Transfer                   "transfer"                  value-moving; inbound to the
//                                                                 fee wallet = the fee transfer
//   3  CreateWithSeed             "createAccountWithSeed"     value-moving (funded creation)
//   4  AdvanceNonceAccount        "advanceNonce"              inert (no lamports move)
//   5  WithdrawNonceAccount       "withdrawFromNonce"         value-moving (empties the
//                                                                 nonce account to a destination)
//   6  InitializeNonceAccount     "initializeNonce"           PROHIBITED after the fee by the
//                                                                 explicit owner ruling 2026-11-24 -
//                                                                 a DELIBERATELY STRICTER policy than
//                                                                 value-inertness requires. It is NOT
//                                                                 lamport-moving: the account must
//                                                                 already be rent-exempt, and the
//                                                                 instruction initializes state
//                                                                 (authorized) only. The prohibition
//                                                                 stands; the rationale is corrected
//                                                                 (auditor round 4).
//   7  AuthorizeNonceAccount      "authorizeNonce"            inert (no lamports move)
//   8  Allocate                   "allocate"                  inert
//   9  AllocateWithSeed           "allocateWithSeed"          inert
//   10 AssignWithSeed             "assignWithSeed"            inert
//   11 TransferWithSeed           "transferWithSeed"          value-moving; inbound to the
//                                                                 fee wallet = the fee transfer
//   13 CreateAccountAllowPrefund  "createAccountAllowPrefund" value-moving UNCONDITIONALLY.
//        SIMD-0312 (status: Activated; mainnet activation 2026-05-29,
//        Agave 4.0 cycle): discriminant 13, CreateAccount's data
//        layout (u32 tag + u64 lamports + u64 space + Pubkey owner =
//        52 bytes), and an OPTIONAL funding account at index 1 -
//        when lamports > 0 it transfers those lamports from the
//        funding account to the new account. HONEST NOTE: an
//        unfunded variant (lamports 0) is classified value-moving
//        anyway, by choice, on the stricter side. The installed
//        @solana/web3.js 1.99.0 does not know this instruction (zero
//        AllowPrefund references), so the recognition is hand-rolled.
//
// Token programs (SPL and Token-2022; tags verified against the
// installed @solana/spl-token source, TokenInstruction in
// src/instructions/types.ts; parsed names from agave
// transaction-status/src/parse_token.rs):
//   9  CloseAccount               "closeAccount"              value-moving (returns rent)
//   8  Burn                       "burn"                      value-moving (destroys tokens)
//   15 BurnChecked                "burnChecked"               value-moving (tag + u64 amount
//                                                                 + u8 decimals = 10 bytes)
//
// Metaplex Token Metadata:
//      BurnNft (tag 29, one data byte, unparsed)              value-moving (closes three
//                                                                 accounts by CPI)
//
// Exactly-one is counted in inbound transfer INSTRUCTIONS regardless
// of amount (owner ruling 2026-11-24): a zero-lamport transfer to the
// fee wallet counts toward the one; the amount check itself reads
// lamports as always.

import bs58 from "bs58";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const MPL_TOKEN_METADATA_PROGRAM =
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export const MPL_BURN_NFT_TAG = 29;

export const SYSTEM_VALUE_MOVING_TAGS = new Set([0, 2, 3, 5, 6, 11, 13]);

// One decoded instruction: programId, account pubkeys, raw data.
export function decodeIx(ix, accountKeys) {
  const programId = accountKeys[ix.programIdIndex];
  if (!programId) return null;
  const accounts = (ix.accounts ?? []).map((i) => accountKeys[i]);
  if (accounts.some((a) => !a)) return null;
  let data;
  try {
    data = Buffer.from(bs58.decode(ix.data ?? ""));
  } catch {
    return null;
  }
  return { programId, accounts, data };
}

// True when the RAW instruction transfers INTO the fee wallet,
// regardless of amount (owner ruling 2026-11-24: count instructions,
// not amounts). The lamports figure for the amount check keeps coming
// from the bell's inboundLamports.
function inboundFeeTransferWire(ix, feeWallet) {
  if (ix.programId !== SYSTEM_PROGRAM || ix.data.length < 12) return false;
  const tag = ix.data.readUInt32LE(0);
  const destination =
    tag === 2 ? ix.accounts[1] : tag === 11 ? ix.accounts[2] : undefined;
  return destination === feeWallet;
}

// Per-instruction facts for the structural check, RAW wire path (the
// bell): is this instruction an inbound fee transfer, and is it
// value-moving per the unified table above?
export function ixFacts(ix, feeWallet) {
  let dataLen = 0;
  let firstByte = null;
  if (ix.data && ix.data.length > 0) {
    dataLen = ix.data.length;
    firstByte = ix.data[0];
  }
  const isTokenProgram =
    ix.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
    ix.programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  return {
    isInboundFeeTransfer: inboundFeeTransferWire(ix, feeWallet),
    isValueMoving:
      (ix.programId === SYSTEM_PROGRAM &&
        dataLen >= 4 &&
        SYSTEM_VALUE_MOVING_TAGS.has(ix.data.readUInt32LE(0))) ||
      (isTokenProgram && firstByte === 9) ||
      (isTokenProgram && firstByte === 8 && dataLen === 9) ||
      // BurnChecked: tag 15 + u64 amount + u8 decimals, exactly 10
      // bytes (verified against the installed @solana/spl-token
      // source: TokenInstruction.BurnChecked = 15 in
      // src/instructions/types.ts, the u8/u64/u8 layout in
      // src/instructions/burnChecked.ts).
      (isTokenProgram && firstByte === 15 && dataLen === 10) ||
      (ix.programId === MPL_TOKEN_METADATA_PROGRAM &&
        dataLen === 1 &&
        firstByte === MPL_BURN_NFT_TAG),
  };
}

// True when a PARSED instruction transfers INTO the fee wallet,
// regardless of amount (owner ruling 2026-11-24). "transferWithSeed"
// joined "transfer" in auditor round 4 (2026-11-24): the parsed
// name is agave's for System tag 11, and its parsed info carries
// destination and lamports exactly like "transfer" does.
export function parsedInboundFeeTransfer(ix, feeWallet) {
  if (String(ix.programId) !== SYSTEM_PROGRAM) return false;
  const type = ix.parsed?.type;
  if (type !== "transfer" && type !== "transferWithSeed") return false;
  return ix.parsed?.info?.destination === feeWallet;
}

const SYSTEM_VALUE_MOVING_PARSED_TYPES = new Set([
  "transfer",
  "transferWithSeed",
  "createAccount",
  "createAccountWithSeed",
  "withdrawFromNonce",
  "initializeNonce",
  "createAccountAllowPrefund",
]);

// Per-instruction facts for the structural check, PARSED shape path
// (the counter): the same unified table, decoded from
// getParsedTransaction shapes. Deliberately a SEPARATE decoder from
// ixFacts - the counter reads parsed JSON, the bell reads raw wires -
// pinned to identical facts by tests/feeWireFacts.test.ts.
export function parsedInstructionFacts(ix, feeWallet) {
  const mplBurnNft =
    String(ix.programId) === MPL_TOKEN_METADATA_PROGRAM &&
    (() => {
      try {
        const bytes = bs58.decode(ix.data ?? "");
        return bytes.length === 1 && bytes[0] === MPL_BURN_NFT_TAG;
      } catch {
        return false;
      }
    })();
  return {
    isInboundFeeTransfer: parsedInboundFeeTransfer(ix, feeWallet),
    isValueMoving:
      (String(ix.programId) === SYSTEM_PROGRAM &&
        SYSTEM_VALUE_MOVING_PARSED_TYPES.has(ix.parsed?.type)) ||
      ix.parsed?.type === "closeAccount" ||
      ix.parsed?.type === "burn" ||
      ix.parsed?.type === "burnChecked" ||
      mplBurnNft,
  };
}
