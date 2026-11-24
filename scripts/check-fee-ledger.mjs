// Operator tooling: the fee-ledger anomaly bell. Independent, read-only
// re-derivation of the fee rule straight from chain data, so the public
// /fees page is watched by something other than hope.
//
// NOT an import of feeLedger.ts on purpose: this is a second
// implementation of the same published rule (repair-shaped transaction =
// token-program closeAccount + System transfer INTO the fee wallet;
// fee must equal exactly floor(1%) of the rent the closes freed, or,
// since the batched burn-and-close (owner decision 2026-11-22), the
// sum of each account's own floor(1%) - the dual-arm comparison in
// ./fee-verdict-arms.mjs, both arms exact). If this script and the
// product page ever disagree, that disagreement is itself a finding.
// Run from the repo root: node scripts/check-fee-ledger.mjs
//
// The signature walk paginates with the before cursor until exhausted
// (the pattern scripts/update-recovered-totals.mjs installed), so
// history growth past any single page can never silently narrow the
// audit. A null getTransaction response that survives its null-read
// retries is an UNVERIFIABLE row, never a pass, and the exit ladder is
// honest:
//
// Exit 0 = every repair-shaped row in the full history was actually
//          verified against the 1% rule (or the history holds none).
// Exit 1 = ALARM: a verified row's transferred lamports differ from the
//          1% rule, or this script's fee wallet disagrees with the app's.
// Exit 2 = the audit could not complete: rows remain unverifiable after
//          bounded in-place retries, or the RPC could not be reached.
//          No verdict, never an alarm. The bell job fails on this by
//          nature (nonzero exit), which is the intended alarm semantics.
//
// Failed transactions and non-repair-shaped rows are not violations and
// not unverifiable: they are classified, counted, and printed.

import { readFileSync } from "node:fs";

import bs58 from "bs58";

import { feeConforms, feeRowStructureConforms } from "./fee-verdict-arms.mjs";

const FEE_WALLET = "6qhajWTtUKadkMaumpADGBkmPkASiwXRqGtqd8ypL74K";

// Address-sync guard (audit 2026-09-29, finding F1): the fee-rule
// derivation below stays a second independent implementation, but the
// audited ADDRESS is pinned to the app's. Without this, a fee wallet
// rotated in src/lib/solana/fees.ts would leave this script reading the
// old address forever: no new rows, exit 0, a silent unaudited gap. The
// app's MAINNET_FEE_WALLET is extracted from fees.ts and compared as a
// full string - a mismatch, or a fees.ts whose constant can no longer be
// found (refactor), is an alarm, never a pass.
const appFeeWallet = readFileSync(
  new URL("../src/lib/solana/fees.ts", import.meta.url),
  "utf8"
).match(/MAINNET_FEE_WALLET\s*=\s*new\s+PublicKey\(\s*"([1-9A-HJ-NP-Za-km-z]+)"/)
  ?.[1];
if (appFeeWallet !== FEE_WALLET) {
  console.log(
    "ALARM: fee wallet sync failure - scripts/check-fee-ledger.mjs and src/lib/solana/fees.ts disagree."
  );
  console.log(`  this script: ${FEE_WALLET}`);
  console.log(
    `  fees.ts:     ${appFeeWallet ?? "(MAINNET_FEE_WALLET constant not found)"}`
  );
  process.exit(1);
}
const ENDPOINT = "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
]);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
// The value-moving System instruction tags - the ONE unified
// definition across all three implementations (auditor round 3,
// 2026-11-24; the app ledger, this bell, and the weekly counter may
// differ in decoding but never in verdict). Tags verified against the
// installed @solana/web3.js 1.99.0 source
// (node_modules/@solana/web3.js/src/programs/system.ts,
// SYSTEM_INSTRUCTION_LAYOUTS): Create index 0, Assign 1, Transfer 2,
// CreateWithSeed 3, AdvanceNonceAccount 4, WithdrawNonceAccount 5,
// InitializeNonceAccount 6, AuthorizeNonceAccount 7, Allocate 8,
// AllocateWithSeed 9, AssignWithSeed 10, TransferWithSeed 11.
// Explicit owner nonce ruling 2026-11-24: WithdrawNonceAccount (5)
// and InitializeNonceAccount (6) are IN - they are part of moving a
// nonce account's lamports; AdvanceNonceAccount (4) and
// AuthorizeNonceAccount (7) are OUT - no lamports move.
const SYSTEM_VALUE_MOVING_TAGS = new Set([0, 2, 3, 5, 6, 11]);
// The Metaplex Token Metadata program and its BurnNft instruction (tag
// 29, one data byte): the dead-NFT burn-and-close whose three closes
// (metadata PDA, token account, master edition PDA - the instruction's
// account keys 0, 3, 4) ride as CPI inner instructions. Owner ruling
// 2026-11-13 (directive item 4): these rows enter the bell's 1% audit,
// and their rent is the ACTUAL return (preBalances - postBalances of
// keys 0, 3, 4) - a husked metadata close keeps its stored fee behind,
// and preBalances alone would bless lamports the user never received.
const MPL_TOKEN_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const MPL_BURN_NFT_TAG = 29;
const MPL_BURN_NFT_CLOSED_KEYS = [0, 3, 4];
// Signatures per listing page; the walk repeats until a short page ends
// the history. Transaction fetches pace at one per second: the bell
// walks the ledger from a shared GitHub Actions IP, which the public
// endpoint throttles at a sustained rate far below what a desktop gets
// away with (run 210, 2026-11-12: the walk's own pacing is minutes, yet
// the runner still lost most of its step time to 429 retries, and one
// row exhausted its budget - the audit honestly exited 2 on a
// conforming ledger). The fix is patience, not a narrower audit.
const SIGNATURES_PER_PAGE = 1000;
const TX_PACING_MS = 1000;
// Bounded in-place retries for one getTransaction fetch that throws
// (network/RPC failure). The backoff grows per attempt because throttle
// windows on the shared runner IP arrive in bursts lasting tens of
// seconds, not the fixed 2s/4s a desktop-sized budget assumed.
const TX_FETCH_ATTEMPTS = 5;
const TX_FETCH_BACKOFF_MS = [2000, 8000, 30000, 90000];
// A read that SUCCEEDS with a null body is no longer believed on the
// first answer (owner word 2026-11-22, the E422 shelf option): the
// public endpoint occasionally returns a healthy 200 with no
// transaction for a signature it serves fine moments later (runs 224,
// 228, 231 - 2026-11-18/20/22 - one null row each, all verified
// conforming on the next run), and each such flake was a red bell and
// an owner email for a conforming ledger. A null gets
// NULL_TX_READ_ATTEMPTS reads paced NULL_TX_READ_BACKOFF_MS apart;
// worst case a flaky row costs about a minute before the verdict. Only
// a null that SURVIVES the retries is definitive (pruned or
// unreadable) - still an unverifiable row, never a pass, exit 2
// unchanged.
const NULL_TX_READ_ATTEMPTS = 3;
const NULL_TX_READ_BACKOFF_MS = 30000;

const sleep = (ms) => new Promise((x) => setTimeout(x, ms));

// One JSON-RPC call, with bounded patience for the public endpoint's
// throttles and gateway hiccups. A 429 or 5xx is retried with a sleep
// that grows per attempt (a flat 8s twice kept failing on the shared
// runner IP); network-level fetch throws and non-JSON bodies get the
// same patience, because a throttled response is not always parseable
// JSON. The status code rides in the thrown message so the row-level
// WARN names what actually happened. Anything else surfaces
// immediately and lets the row-level fetch budget decide the row's
// fate - an RPC error that is not a throttle is a real answer.
const RPC_ATTEMPTS = 3;
const RPC_RETRY_MS = 10000;

async function rpc(method, params, attempt = 1) {
  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (e) {
    if (attempt < RPC_ATTEMPTS) {
      await sleep(RPC_RETRY_MS * attempt);
      return rpc(method, params, attempt + 1);
    }
    throw e;
  }
  if (!r.ok) {
    const retryable = r.status === 429 || r.status >= 500;
    if (retryable && attempt < RPC_ATTEMPTS) {
      await sleep(RPC_RETRY_MS * attempt);
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`HTTP ${r.status} on ${method}`);
  }
  let j;
  try {
    j = await r.json();
  } catch {
    if (attempt < RPC_ATTEMPTS) {
      await sleep(RPC_RETRY_MS * attempt);
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`non-JSON response on ${method}`);
  }
  if (j.error) {
    if (
      attempt < RPC_ATTEMPTS &&
      String(j.error.message ?? "").match(/429|too many|rate|limit/i)
    ) {
      await sleep(RPC_RETRY_MS * attempt);
      return rpc(method, params, attempt + 1);
    }
    throw new Error(JSON.stringify(j.error).slice(0, 120));
  }
  return j.result;
}

// One decoded instruction: programId, account pubkeys, raw data.
function decodeIx(ix, accountKeys) {
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

// Per-instruction facts for the structural check (finding 3,
// escalated; unified value-moving set, auditor round 3 2026-11-24):
// is this instruction an inbound fee transfer, and is it value-moving
// (a system transfer, funded system account creation, nonce-account
// withdraw/initialize, a token close/burn/BurnChecked, or a Metaplex
// BurnNft)?
function ixFacts(ix) {
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
    // Owner ruling 2026-11-24: the literal rule counts inbound
    // transfer INSTRUCTIONS regardless of amount - a zero-lamport
    // transfer to the fee wallet counts toward exactly-one. The
    // amount check itself (inboundLamports) is unchanged.
    isInboundFeeTransfer: isInboundFeeTransferToWallet(ix),
    isValueMoving:
      (ix.programId === "11111111111111111111111111111111" &&
        dataLen >= 4 &&
        SYSTEM_VALUE_MOVING_TAGS.has(ix.data.readUInt32LE(0))) ||
      (isTokenProgram && firstByte === 9) ||
      (isTokenProgram && firstByte === 8 && dataLen === 9) ||
      // BurnChecked: tag 15 + u64 amount + u8 decimals, exactly 10
      // bytes (auditor round 3 2026-11-24; verified against the
      // installed @solana/spl-token source: TokenInstruction
      // .BurnChecked = 15 in src/instructions/types.ts, the u8/u64/u8
      // layout in src/instructions/burnChecked.ts).
      (isTokenProgram && firstByte === 15 && dataLen === 10) ||
      (ix.programId === "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s" &&
        dataLen === 1 &&
        firstByte === 29),
  };
}

// True when the instruction transfers INTO the fee wallet, regardless
// of amount (owner ruling 2026-11-24: count instructions, not
// amounts). The lamports figure for the amount check keeps coming
// from inboundLamports below.
function isInboundFeeTransferToWallet(ix) {
  if (ix.programId !== SYSTEM_PROGRAM || ix.data.length < 12) return false;
  const tag = ix.data.readUInt32LE(0);
  const destination =
    tag === 2 ? ix.accounts[1] : tag === 11 ? ix.accounts[2] : undefined;
  return destination === FEE_WALLET;
}

// Lamports moved INTO the fee wallet by one instruction, or 0.
function inboundLamports(ix) {
  if (ix.programId !== SYSTEM_PROGRAM || ix.data.length < 12) return 0;
  const tag = ix.data.readUInt32LE(0);
  const destination =
    tag === 2 ? ix.accounts[1] : tag === 11 ? ix.accounts[2] : undefined;
  if (destination !== FEE_WALLET) return 0;
  const lamports = Number(ix.data.readBigUInt64LE(4));
  return Number.isSafeInteger(lamports) && lamports > 0 ? lamports : 0;
}

// The full signature history of the fee wallet, oldest page last, via
// the before cursor. A short page (fewer than the asked-for limit) ends
// the walk; the cursor prevents page overlap, and the dedupe below is
// defense in depth against node-side pagination inconsistency.
const seen = new Set();
const sigs = [];
let pages = 0;
let before = null;
for (;;) {
  const options = { limit: SIGNATURES_PER_PAGE };
  if (before) options.before = before;
  let page;
  try {
    page = await rpc("getSignaturesForAddress", [FEE_WALLET, options]);
  } catch (e) {
    console.log(`ALARM-INCOMPLETE: the signature listing failed: ${e.message}`);
    console.log("exit 2: the audit could not complete.");
    process.exit(2);
  }
  pages += 1;
  for (const s of page) {
    if (!seen.has(s.signature)) {
      seen.add(s.signature);
      sigs.push(s);
    }
  }
  if (page.length < SIGNATURES_PER_PAGE) break;
  before = page[page.length - 1].signature;
}

let checked = 0;
let fees = 0;
let failedOnChain = 0;
let notRepairShaped = 0;
let nullRecovered = 0;
const violations = [];
const noVerdict = [];

async function fetchTransaction(signature) {
  let nulls = 0;
  for (let attempt = 1; attempt <= TX_FETCH_ATTEMPTS; attempt++) {
    let tx;
    try {
      tx = await rpc("getTransaction", [
        signature,
        { maxSupportedTransactionVersion: 1, encoding: "json" },
      ]);
    } catch (e) {
      if (attempt === TX_FETCH_ATTEMPTS) {
        console.log(
          `WARN could not fetch ${signature.slice(0, 12)} after ${TX_FETCH_ATTEMPTS} attempts: ${e.message}`
        );
        return undefined;
      }
      await sleep(TX_FETCH_BACKOFF_MS[attempt - 1]);
      continue;
    }
    if (tx !== null) {
      if (nulls > 0) nullRecovered += 1;
      return tx;
    }
    // A null body: paced retries before it is believed (see
    // NULL_TX_READ_ATTEMPTS above). A null that outlasts the budget is
    // definitive and the WARN below names it for the log reader.
    nulls += 1;
    if (nulls >= NULL_TX_READ_ATTEMPTS) {
      console.log(
        `WARN ${signature.slice(0, 12)} returned no transaction body after ${NULL_TX_READ_ATTEMPTS} read(s); row is unverifiable`
      );
      return null;
    }
    await sleep(NULL_TX_READ_BACKOFF_MS);
  }
  return undefined;
}

for (const entry of sigs) {
  if (entry.err) {
    failedOnChain += 1;
    continue;
  }
  const tx = await fetchTransaction(entry.signature);
  if (tx === undefined) {
    noVerdict.push(entry.signature);
    continue;
  }
  if (tx === null) {
    // A definitive null - it survived the null-read retries (pruned or
    // otherwise unreadable; fetchTransaction already WARNed): counted
    // as unverifiable, never skipped silently.
    noVerdict.push(entry.signature);
    continue;
  }
  if (tx.meta?.err != null) {
    failedOnChain += 1;
    continue;
  }
  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey
  );
  const ixs = [];
  const outerIxs = [];
  for (const ix of tx.transaction.message.instructions ?? []) {
    const d = decodeIx(ix, accountKeys);
    if (d) {
      ixs.push(d);
      outerIxs.push(d);
    }
  }
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) {
      const d = decodeIx(ix, accountKeys);
      if (d) ixs.push(d);
    }
  }
  const closes = ixs.filter(
    (ix) =>
      TOKEN_PROGRAMS.has(ix.programId) &&
      ix.data.length === 1 &&
      ix.data[0] === 9
  );
  // The Metaplex BurnNft shape (the dead-NFT burn-and-close, owner
  // ruling 2026-11-13, directive item 4): recognized alongside closes,
  // audited against the same 1% rule, with the rent computed as the
  // ACTUAL return (preBalances - postBalances of account keys 0, 3, 4)
  // - a husked metadata close keeps its stored fee behind, and
  // preBalances alone would bless lamports the user never received.
  const mplBurns = ixs.filter(
    (ix) =>
      ix.programId === MPL_TOKEN_METADATA_PROGRAM &&
      ix.data.length === 1 &&
      ix.data[0] === MPL_BURN_NFT_TAG
  );
  if (closes.length === 0) {
    if (mplBurns.length === 0) {
      notRepairShaped += 1;
      continue; // not repair-shaped
    }
    const lamports = ixs.reduce((sum, ix) => sum + inboundLamports(ix), 0);
    if (lamports <= 0) {
      notRepairShaped += 1;
      continue;
    }
    checked += 1;
    fees += lamports;
    let rent = 0;
    // Per-account rents: what the dual-arm conformance comparison (the
    // shared helper) needs alongside the total. This path previously
    // accumulated only the total; the list carries the same deltas.
    const perAccount = [];
    let verdictPossible = true;
    const pre = tx.meta?.preBalances;
    const post = tx.meta?.postBalances;
    if (!Array.isArray(pre) || !Array.isArray(post)) {
      verdictPossible = false;
    } else {
      for (const burn of mplBurns) {
        for (const key of MPL_BURN_NFT_CLOSED_KEYS) {
          const index = accountKeys.indexOf(burn.accounts[key]);
          if (index < 0 || index >= pre.length || index >= post.length) {
            verdictPossible = false;
            break;
          }
          const delta = pre[index] - post[index];
          if (delta < 0) {
            verdictPossible = false;
            break;
          }
          rent += delta;
          perAccount.push(delta);
        }
        if (!verdictPossible) break;
      }
    }
    if (!verdictPossible) {
      noVerdict.push(entry.signature);
      continue;
    }
    const expected = Math.floor(rent / 100);
    if (!feeConforms(lamports, perAccount) ||
        !feeRowStructureConforms(outerIxs.map((ix) => ixFacts(ix)))) {
      violations.push({ signature: entry.signature, lamports, rent, expected });
    }
    await sleep(TX_PACING_MS);
    continue;
  }
  // Metaplex BurnNft rows riding WITH closes in one transaction are
  // audited below, together with the closes, under the combined rent.
  const lamports = ixs.reduce((sum, ix) => sum + inboundLamports(ix), 0);
  if (lamports <= 0) {
    notRepairShaped += 1;
    continue;
  }
  checked += 1;
  fees += lamports;
  // Rent freed: UNIQUE closed accounts (deduplicated — a wallet can
  // append its own closeAccount for the token account a BurnNft already
  // closes), each counted once as preBalances - postBalances, the
  // actual return (owner ruling 2026-11-13). closeAccount rows have
  // post 0, so pre - post = pre — the figure the bell always counted.
  let rent = 0;
  // Per-account rents: what the dual-arm conformance comparison (the
  // shared helper) needs alongside the total. This path previously
  // accumulated only the total; the list carries the same deltas.
  const perAccount = [];
  let verdictPossible = true;
  const closedAccounts = new Map();
  for (const close of closes) {
    closedAccounts.set(close.accounts[0], false);
  }
  for (const burn of mplBurns) {
    for (const key of MPL_BURN_NFT_CLOSED_KEYS) {
      const addr = burn.accounts[key];
      closedAccounts.set(addr, true);
    }
  }
  const pre = tx.meta?.preBalances;
  const post = tx.meta?.postBalances;
  if (!Array.isArray(pre) || !Array.isArray(post)) {
    verdictPossible = false;
  } else {
    for (const [addr, sawBurnNft] of closedAccounts) {
      const index = accountKeys.indexOf(addr);
      if (index < 0 || index >= pre.length || index >= post.length) {
        verdictPossible = false;
        break;
      }
      const delta = pre[index] - post[index];
      rent += delta;
      perAccount.push(delta);
    }
  }
  if (!verdictPossible) {
    noVerdict.push(entry.signature);
    continue;
  }
  const expected = Math.floor(rent / 100);
  if (!feeConforms(lamports, perAccount) ||
      !feeRowStructureConforms(outerIxs.map((ix) => ixFacts(ix)))) {
    violations.push({ signature: entry.signature, lamports, rent, expected });
  }
  await sleep(TX_PACING_MS);
}

console.log(
  `fee ledger check: ${checked} repair fee(s) verified across ${sigs.length} signature(s) in ${pages} page(s), ` +
    `${fees} lamports total, ${noVerdict.length} unverifiable, ` +
    `${failedOnChain} failed on chain, ${notRepairShaped} not repair-shaped, ` +
    `${nullRecovered} null read(s) recovered by retry, ` +
    `${violations.length} violation(s)`
);
if (violations.length > 0) {
  console.log("ALARM: conformance violations (transferred != floor(1% of rent)):");
  for (const v of violations) {
    console.log(
      `  ALARM ${v.signature} transferred ${v.lamports} but rent ${v.rent} implies ${v.expected}`
    );
  }
  process.exit(1);
}
if (noVerdict.length > 0) {
  console.log(
    "exit 2: the audit could not complete - rows remain unverifiable:"
  );
  for (const s of noVerdict) {
    console.log(`  UNVERIFIABLE ${s}`);
  }
  process.exit(2);
}
console.log("exit 0: every relevant row was verified.");
process.exit(0);
