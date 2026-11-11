// Operator tooling: the fee-ledger anomaly bell. Independent, read-only
// re-derivation of the fee rule straight from chain data, so the public
// /fees page is watched by something other than hope.
//
// NOT an import of feeLedger.ts on purpose: this is a second
// implementation of the same published rule (repair-shaped transaction =
// token-program closeAccount + System transfer INTO the fee wallet;
// fee must equal exactly floor(1%) of the rent the closes freed). If
// this script and the product page ever disagree, that disagreement is
// itself a finding. Run from the repo root: node scripts/check-fee-ledger.mjs
//
// The signature walk paginates with the before cursor until exhausted
// (the pattern scripts/update-recovered-totals.mjs installed), so
// history growth past any single page can never silently narrow the
// audit. A null getTransaction response is an UNVERIFIABLE row, never a
// pass, and the exit ladder is honest:
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
// Signatures per listing page; the walk repeats until a short page ends
// the history. Transaction fetches pace at one every 400ms so the public
// endpoint is not hammered.
const SIGNATURES_PER_PAGE = 1000;
const TX_PACING_MS = 400;
// Bounded in-place retries for one getTransaction fetch that throws
// (network/RPC failure). A retry SUCCEEDS with a null response is still
// an unverifiable row: null is a definitive answer (pruned or
// unreadable), not a failure.
const TX_FETCH_ATTEMPTS = 3;

const sleep = (ms) => new Promise((x) => setTimeout(x, ms));

async function rpc(method, params, attempt = 1) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) {
    if (attempt < 3 && String(j.error.message ?? "").match(/429|too many/i)) {
      await sleep(8000);
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
const violations = [];
const noVerdict = [];

async function fetchTransaction(signature) {
  for (let attempt = 1; attempt <= TX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await rpc("getTransaction", [
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
      await sleep(2000 * attempt);
    }
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
    // A definitive null (pruned or otherwise unreadable): counted as
    // unverifiable, never skipped silently.
    console.log(
      `WARN no transaction body returned for ${entry.signature.slice(0, 12)}; row is unverifiable`
    );
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
  for (const ix of tx.transaction.message.instructions ?? []) {
    const d = decodeIx(ix, accountKeys);
    if (d) ixs.push(d);
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
  if (closes.length === 0) {
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
  // Rent freed: each closed account's pre-tx balance.
  let rent = 0;
  let verdictPossible = true;
  for (const close of closes) {
    const index = accountKeys.indexOf(close.accounts[0]);
    const pre = tx.meta?.preBalances;
    if (index < 0 || !Array.isArray(pre) || index >= pre.length) {
      verdictPossible = false;
      break;
    }
    rent += pre[index];
  }
  if (!verdictPossible) {
    noVerdict.push(entry.signature);
    continue;
  }
  const expected = Math.floor(rent / 100);
  if (lamports !== expected) {
    violations.push({ signature: entry.signature, lamports, rent, expected });
  }
  await sleep(TX_PACING_MS);
}

console.log(
  `fee ledger check: ${checked} repair fee(s) verified across ${sigs.length} signature(s) in ${pages} page(s), ` +
    `${fees} lamports total, ${noVerdict.length} unverifiable, ` +
    `${failedOnChain} failed on chain, ${notRepairShaped} not repair-shaped, ` +
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
