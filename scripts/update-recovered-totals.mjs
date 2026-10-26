// Operator tooling: refreshes the recovered-to-date counter constant.
//
// Walks the mainnet fee wallet's full history read-only and rewrites
// src/lib/recoveredTotals.ts with { asOf, nextUpdate, wallets, closes,
// lamportsFreed }. The classification mirrors the shipped ledger exactly:
// a row is a repair row when the transaction contains at least one
// token-program closeAccount AND a System transfer INTO the fee wallet;
// the fee must equal exactly floor(1%) of the rent the closes freed.
// Known operator-test signatures and the wallet's own funding transfer
// are excluded. If any organic row fails the 1% rule, the script aborts
// and writes NOTHING - the counter never ships a number derived from
// non-conforming data.
//
// Run from the repo root on the weekly bump (Sundays, per the owner's
// ruling): node scripts/update-recovered-totals.mjs
// Then commit the regenerated constant, open the bump PR, and obtain the
// owner's merge word. A missed week leaves a true as-of date - a late
// update, never a lie.
//
// NOT an import of feeLedger.ts on purpose: a second implementation of
// the published rule, like scripts/check-fee-ledger.mjs. The audited
// address is pinned to the app's via the same address-sync guard.

import { readFileSync, writeFileSync } from "node:fs";

import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";

const FEE_WALLET = "6qhajWTtUKadkMaumpADGBkmPkASiwXRqGtqd8ypL74K";
const SYSTEM_PROGRAM = "1".repeat(32);
const OUT_FILE = new URL("../src/lib/recoveredTotals.ts", import.meta.url);
const FEES_TS = new URL("../src/lib/solana/fees.ts", import.meta.url);

// Known operator-test signatures (mirror of MAINNET_TEST_SIGNATURES in
// src/lib/solana/feeLedger.ts; kept in step by the weekly bump ritual -
// when the app list gains a signature, add it here too).
const TEST_SIGS = new Set([
  "i7Riy8r8TSts5dSoYayhjVUuRfkf4CTsd3JtYdVEFTjCNwEhMHhhJqMeeLkAyoGdHunvvsq7pZZwNcj6A7udhzY",
  "4GnC4yuZUB2sC1Ft6aFP4ouhfaBKgHmAJBpYK4cCSVqeEmFUouDQorsSsUxw2wpnU2DqrM5CswPdphvagPqcPswi",
  "qsbutSckYFLtSXXV9ewBsWqoPMePdpFcafuCR8pEXeu9yVUQLaAEMVwxV3wEv1cchn6ge3LTFYSCKXjn97yznPQ",
  "4BsA9nPxEePuHpNyN8KYzZYbCZyWVADojyiv4JvXvDxzpDt17Xq3n2Dc41fsqtaJH2FjYqhC5ectmUepbD2g9aAB",
  "2EdGP7YSr2oKAtibpAFAnfUhAhsk8jFSaNKdUZz3z43wGrF9YR6BYvxePwhnrpx2PfhHbBE3bBCFTsbdybMauBww",
  "2ZMJZDi7frGRw7GxBGwDfc2MYqbjzhobt4r2sGEWcxGevnonMyjAconXKpCw74kLBEb8mjcCckvp2aVTimFC1m55",
  "2V4dcrHEApzHDS9PqxWo1KeeK8a3HvVLyPsxVfq3yEktjdqH8NX77nzGZVT4QXTaVy8sWvszA8xDx8N2UrYGfrcw",
]);

// Address-sync guard (same pattern as scripts/check-fee-ledger.mjs): the
// audited address must equal the app's MAINNET_FEE_WALLET. A rotation in
// fees.ts that skips this script is an alarm, never a stale silent read.
const feesSrc = readFileSync(FEES_TS, "utf8");
const appWalletMatch = feesSrc.match(
  /MAINNET_FEE_WALLET\s*=\s*new PublicKey\(\s*"([1-9A-HJ-NP-Za-km-z]+)"/
);
if (!appWalletMatch) {
  console.error("ALARM: could not find MAINNET_FEE_WALLET in src/lib/solana/fees.ts");
  process.exit(2);
}
if (appWalletMatch[1] !== FEE_WALLET) {
  console.error("ALARM: fees.ts fee wallet differs from this script's wallet");
  process.exit(2);
}

let env = {};
try {
  env = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
  );
} catch {}

const candidates = [
  ...(env.NEXT_PUBLIC_MAINNET_RPC_ENDPOINTS || "").split(",").map((s) => s.trim()).filter(Boolean),
  env.NEXT_PUBLIC_MAINNET_RPC_ENDPOINT,
  "https://api.mainnet-beta.solana.com",
].filter(Boolean);

let c = null;
for (let i = 0; i < candidates.length; i++) {
  try {
    const probe = new Connection(candidates[i], "confirmed");
    await probe.getVersion();
    c = probe;
    console.log(`endpoint selected: candidate ${i + 1} of ${candidates.length}`);
    break;
  } catch {
    // dead or unreachable entry; try the next
  }
}
if (!c) {
  console.error("no healthy endpoint among", candidates.length, "candidates");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(fn) {
  for (let a = 0; a < 4; a++) {
    try {
      return await fn();
    } catch (e) {
      const m = String(e && e.message);
      if ((m.includes("429") || m.toLowerCase().includes("rate")) && a < 3) {
        await sleep(1500 * (a + 1));
        continue;
      }
      throw e;
    }
  }
}

const sigs = await call(() => c.getSignaturesForAddress(new PublicKey(FEE_WALLET), { limit: 1000 }));
console.log("lifetime signatures:", sigs.length);

let organicRows = 0;
const wallets = new Set();
let closes = 0;
let freedTotal = 0n;
let violations = 0;
let skipped = 0;

for (const s of sigs) {
  await sleep(120);
  const t = await call(() => c.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 }));
  if (!t || t.meta?.err) { skipped++; continue; }
  const ix = t.transaction.message.instructions || [];
  const closesIx = ix.filter((i) => i.parsed?.type === "closeAccount");
  const feeXfers = ix.filter(
    (i) => String(i.programId) === SYSTEM_PROGRAM && i.parsed?.type === "transfer" && i.parsed?.info?.destination === FEE_WALLET
  );
  if (closesIx.length === 0 || feeXfers.length === 0) { skipped++; continue; }
  const isTest = TEST_SIGS.has(s.signature);
  const keys = (t.transaction.message.accountKeys || []).map((k) => (typeof k === "string" ? k : String(k.pubkey)));
  let freed = 0n;
  for (const cl of closesIx) {
    const src = cl.parsed.info?.source ?? cl.parsed.info?.account;
    const idx = keys.indexOf(src);
    if (idx >= 0) freed += BigInt(t.meta.preBalances[idx]);
  }
  const feeAmt = feeXfers.reduce((acc, x) => acc + BigInt(x.parsed.info.lamports), 0n);
  if (isTest) continue;
  organicRows++;
  if (feeAmt !== freed / 100n) {
    violations++;
    console.log("CONFORMANCE VIOLATION", s.signature, "fee", feeAmt.toString(), "freed", freed.toString());
    continue;
  }
  const signer = t.transaction.message.accountKeys.find((k) => k.signer);
  if (signer) wallets.add(typeof signer === "string" ? signer : String(signer.pubkey));
  closes += closesIx.length;
  freedTotal += freed;
}

if (violations > 0) {
  console.error(`ALARM: ${violations} organic row(s) violate the 1% rule - constant NOT updated`);
  process.exit(1);
}

const lamportsFreed = freedTotal.toString();
const today = new Date().toISOString().slice(0, 10);
// nextUpdate: the Sunday strictly after asOf.
const asOfDate = new Date(`${today}T00:00:00Z`);
const daysUntilSunday = (7 - asOfDate.getUTCDay()) % 7 || 7;
const nextUpdate = new Date(asOfDate.getTime() + daysUntilSunday * 86400000).toISOString().slice(0, 10);

const out = `// Generated by scripts/update-recovered-totals.mjs - do not hand-edit.
// Rerun the script to refresh (the weekly bump ritual, Sundays). The
// number counts rent freed by fee-bearing repairs and burn-closes on
// mainnet: known operator tests and the wallet's funding transfer are
// excluded, and every counted row satisfied fee == floor(1% of freed)
// at generation time.

export interface RecoveredTotals {
  /** ISO date the walk ran. */
  asOf: string;
  /** ISO date of the next scheduled weekly bump (the Sunday after asOf). */
  nextUpdate: string;
  /** Distinct wallets whose fee rows are counted. */
  wallets: number;
  /** Token accounts closed across the counted rows. */
  closes: number;
  /** Sum of rent freed by the counted closes, in lamports. */
  lamportsFreed: string;
  /** lamportsFreed formatted as SOL with the ledger's own convention
   *  (nine decimals, trailing zeros trimmed), precomputed so consumers
   *  need no feeLedger import (the homepage shell stays wallet-free). */
  lamportsFreedSol: string;
}

export const RECOVERED_TOTALS: RecoveredTotals = {
  asOf: "${today}",
  nextUpdate: "${nextUpdate}",
  wallets: ${wallets.size},
  closes: ${closes},
  lamportsFreed: "${lamportsFreed}",
  lamportsFreedSol: "${(Number(freedTotal) / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "")}",
};
`;

writeFileSync(OUT_FILE, out);
console.log(`organic rows: ${organicRows} | wallets: ${wallets.size} | closes: ${closes}`);
console.log(`freed total: ${lamportsFreed} lamports = ${Number(freedTotal) / 1e9} SOL`);
console.log(`violations: ${violations} | skipped (tests/funding/non-fee): ${skipped}`);
console.log(`wrote ${OUT_FILE.pathname} (asOf ${today}, nextUpdate ${nextUpdate})`);
