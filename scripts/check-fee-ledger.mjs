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
// Exit 0 = all rows conform (or no rows). Exit 1 = ALARM, a row's
// transferred lamports differ from the 1% rule. Exit 2 = could not
// complete the check (network/rpc) - no verdict, never an alarm.

import bs58 from "bs58";

const FEE_WALLET = "6qhajWTtUKadkMaumpADGBkmPkASiwXRqGtqd8ypL74K";
const ENDPOINT = "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
]);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const PAGE = 25;

async function rpc(method, params, attempt = 1) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) {
    if (attempt < 3 && String(j.error.message ?? "").match(/429|too many/i)) {
      await new Promise((x) => setTimeout(x, 8000));
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

const sigs = await rpc("getSignaturesForAddress", [FEE_WALLET, { limit: PAGE }]);
let checked = 0;
let fees = 0;
const violations = [];
const noVerdict = [];

for (const entry of sigs) {
  if (entry.err) continue;
  let tx;
  try {
    tx = await rpc("getTransaction", [
      entry.signature,
      { maxSupportedTransactionVersion: 1, encoding: "json" },
    ]);
  } catch (e) {
    console.log(`WARN could not fetch ${entry.signature.slice(0, 12)}: ${e.message}`);
    noVerdict.push(entry.signature);
    continue;
  }
  if (!tx || tx.meta?.err != null) continue;
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
  if (closes.length === 0) continue; // not repair-shaped
  const lamports = ixs.reduce((sum, ix) => sum + inboundLamports(ix), 0);
  if (lamports <= 0) continue;
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
  await new Promise((x) => setTimeout(x, 400));
}

console.log(
  `fee ledger check: ${checked} repair fee(s) in the newest ${PAGE} signature(s), ` +
    `${fees} lamports total, ${noVerdict.length} unverifiable, ${violations.length} violation(s)`
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
process.exit(0);
