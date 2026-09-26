"use client";

/**
 * Transaction explainer (UNDERSTAND, M2). Paste a transaction signature,
 * read what the transaction did in plain language.
 *
 * Read-only forever, by owner lock: this page never connects a wallet
 * for signing and never asks you to sign anything. It reuses the fee
 * ledger's fetch and decoder (base64, version-1 capable) and the
 * explain module's plain-language dictionary; anything the dictionary
 * does not know says so instead of guessing.
 *
 * Quiet for now: nothing links here and the page stays out of the
 * sitemap until the suite is announced (M4).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { NetworkBadge } from "@/components/NetworkBadge";
import { WalletRecentTransactions } from "@/components/WalletRecentTransactions";
import { IS_MAINNET } from "@/lib/solana/connection";
import {
  FEE_LEDGER_ENDPOINTS,
  decodeRawTransaction,
  fetchRawTransaction,
  formatBlockTime,
} from "@/lib/solana/feeLedger";
import { explainDecodedTransaction } from "@/lib/solana/explain";
import type { ExplainedTransaction } from "@/lib/solana/explain";
import { analyzeLeftBehind } from "@/lib/solana/postState";
import type { CapabilityEffect, LeftBehindAnalysis } from "@/lib/solana/postState";

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/* Verdict styling: the panel border and headline color follow the worst
 * finding. A failed transaction is amber (notice it) with neutral body
 * copy, because its message is that nothing happened. */
const VERDICT_PANEL_CLASS: Record<LeftBehindAnalysis["verdict"], string> = {
  failed: "rounded border border-zinc-800 bg-zinc-900/50 p-4",
  normal: "rounded border border-zinc-800 bg-zinc-900/50 p-4",
  warning: "rounded border border-amber-900/60 bg-amber-950/20 p-4",
  danger: "rounded border border-red-900/60 bg-red-950/20 p-4",
};

const VERDICT_HEADLINE_CLASS: Record<LeftBehindAnalysis["verdict"], string> = {
  failed: "text-sm font-medium text-amber-400",
  normal: "text-sm font-medium text-zinc-200",
  warning: "text-sm font-medium text-amber-400",
  danger: "text-sm font-medium text-red-400",
};

const EFFECT_CLASS: Record<CapabilityEffect["severity"], string> = {
  info: "text-sm leading-relaxed text-zinc-400",
  warning: "text-sm leading-relaxed text-amber-300",
  danger: "text-sm leading-relaxed text-red-300",
};

type ExplainState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "not-found" }
  | { kind: "unreadable" }
  | { kind: "error"; detail: string }
  | {
      kind: "done";
      signature: string;
      explained: ExplainedTransaction;
      analysis: LeftBehindAnalysis;
    };

const ENDPOINT = IS_MAINNET
  ? FEE_LEDGER_ENDPOINTS["mainnet-beta"]
  : FEE_LEDGER_ENDPOINTS.devnet;

/** Ticking counter for the in-flight read. A changing number is the honest
 *  "not stuck" signal on a slow public endpoint: real time passing, no fake
 *  progress. Same pattern as the homepage's repair counter. */
function ReadingSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono tabular-nums text-zinc-400">{seconds}s</span>
  );
}

export default function UnderstandPage() {
  const [signature, setSignature] = useState("");
  const [state, setState] = useState<ExplainState>({ kind: "idle" });
  // Newest request wins. Every click (form submit or a recent-transactions
  // row) starts a fetch; a slower EARLIER response must never overwrite a
  // later one, so each request is generation-tagged and stale responses are
  // discarded before they can touch state. Same pattern as the scan and
  // ledger hooks. Individual RPC calls are still abort-bounded (30s) in the
  // fetch layer; this guard is about overlapping requests, not timeouts.
  const requestRef = useRef(0);

  async function explain(signatureInput: string) {
    const request = ++requestRef.current;
    const stale = () => request !== requestRef.current;
    if (!SIGNATURE_PATTERN.test(signatureInput)) {
      if (!stale()) setState({ kind: "invalid" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const raw = await fetchRawTransaction(ENDPOINT, signatureInput);
      if (stale()) return;
      if (!raw) {
        setState({ kind: "not-found" });
        return;
      }
      const decoded = decodeRawTransaction(raw);
      if (stale()) return;
      if (!decoded) {
        setState({ kind: "unreadable" });
        return;
      }
      const explained = explainDecodedTransaction(decoded);
      const analysis = analyzeLeftBehind({
        instructions: decoded.instructions,
        failed: raw.meta?.err != null,
      });
      if (stale()) return;
      setState({
        kind: "done",
        signature: signatureInput,
        explained,
        analysis,
      });
    } catch (error) {
      if (stale()) return;
      setState({
        kind: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-2xl">
        <div className="mb-8 flex items-center justify-between">
          <span className="font-mono text-sm text-zinc-400">SOL.repair</span>
          <div className="flex items-center gap-3">
            <NetworkBadge />
            <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-300">
              ← Back
            </Link>
          </div>
        </div>

        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-50">
          Understand a transaction
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-zinc-400">
          Paste a Solana transaction signature. This page reads the
          transaction on chain and explains what each instruction does, in
          plain language. Read-only: this page never connects a wallet for
          signing and never asks you to sign anything. Anything it cannot
          describe says so instead of guessing.
        </p>

        <details className="mb-6 rounded border border-zinc-800 bg-zinc-900/30 p-4">
          <summary className="cursor-pointer text-sm font-medium text-zinc-300">
            How to read this
          </summary>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-zinc-400">
            <li>
              Nothing on this page can sign anything. Connecting a wallet
              only reads the public list of transactions that mention your
              address, and the page never asks for an approval.
            </li>
            <li>
              The panel above the instruction list is the important part.
              It names every lasting change the transaction made: which
              permissions now exist, who holds them, and what ended.
            </li>
            <li>
              Amber means something could not be fully analyzed. Wallets add
              their own instructions when they sign, for example fee
              settings and safety checks. Those are not part of the app you
              used, this tool cannot describe them, and honest reporting
              keeps the panel amber even on an innocent transaction.
            </li>
            <li>
              Red appears in exactly one case: a transaction that hands
              ownership of a token account to a different address. If that
              was not intended, the previous owner may no longer control
              that account.
            </li>
            <li>
              A transaction that failed on chain is reported as changed
              nothing, because a failed transaction has no effects.
            </li>
          </ul>
        </details>

        <div className="mb-6">
          <WalletRecentTransactions
            endpoint={ENDPOINT}
            onSelect={(chosen) => {
              setSignature(chosen);
              void explain(chosen);
            }}
          />
        </div>

        <form
          className="mb-6 flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void explain(signature.trim());
          }}
        >
          <label className="sr-only" htmlFor="signature">
            Transaction signature
          </label>
          <input
            id="signature"
            name="signature"
            autoComplete="off"
            spellCheck={false}
            value={signature}
            onChange={(event) => setSignature(event.target.value)}
            placeholder="Paste a transaction signature"
            className="w-full flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-200 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
          <button
            type="submit"
            disabled={state.kind === "loading"}
            className="rounded bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-300 disabled:opacity-50"
          >
            Explain it
          </button>
        </form>

        {state.kind === "invalid" && (
          <p className="mb-6 text-sm text-red-400">
            That does not look like a transaction signature.
          </p>
        )}

        {state.kind === "loading" && (
          <p className="mb-6 text-sm text-zinc-400">
            Reading the chain... The public endpoint can be slow under load.{" "}
            <ReadingSeconds />
          </p>
        )}

        {state.kind === "not-found" && (
          <p className="mb-6 text-sm text-zinc-300">
            No transaction with that signature was found on this network. It
            may belong to the other network, or it may be too old for the
            RPC to serve.
          </p>
        )}

        {state.kind === "unreadable" && (
          <p className="mb-6 text-sm text-zinc-300">
            The transaction was found but its data could not be read.
            Nothing was sent and nothing changed.
          </p>
        )}

        {state.kind === "error" && (
          <div className="mb-6">
            <p className="text-sm text-red-400">Could not reach the RPC.</p>
            <p className="mt-1 break-all text-xs text-zinc-400">
              {state.detail}
            </p>
          </div>
        )}

        {state.kind === "done" && (
          <section className="space-y-4">
            <div className="rounded border border-zinc-800 bg-zinc-900/50 p-4">
              <p className="break-all font-mono text-xs text-zinc-400">
                {state.signature}
              </p>
              <p className="mt-2 text-xs text-zinc-400">
                Signed {formatBlockTime(state.explained.blockTime)}
              </p>
            </div>
            <div className="space-y-2">
              <p className="font-mono text-xs uppercase tracking-wider text-zinc-400">
                Left behind
              </p>
              <div className={VERDICT_PANEL_CLASS[state.analysis.verdict]}>
                <p className={VERDICT_HEADLINE_CLASS[state.analysis.verdict]}>
                  {state.analysis.headline}
                </p>
                {state.analysis.effects.length > 0 && (
                  <ul className="mt-3 space-y-2">
                    {state.analysis.effects.map((effect, index) => (
                      <li
                        key={index}
                        className={EFFECT_CLASS[effect.severity]}
                      >
                        {effect.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            {state.analysis.verdict === "failed" ? (
              <p className="text-sm text-zinc-400">
                The instructions it attempted are not shown, because none of
                them took effect.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="font-mono text-xs uppercase tracking-wider text-zinc-400">
                  Instructions
                </p>
                <p className="text-sm text-zinc-300">
                  This transaction contains{" "}
                  {state.explained.instructions.length}{" "}
                  {state.explained.instructions.length === 1
                    ? "instruction"
                    : "instructions"}
                  . Every sentence below is generated from the
                  transaction&rsquo;s own bytes.
                </p>
                <ol className="space-y-2">
                  {state.explained.instructions.map((instruction, index) => (
                    <li
                      key={index}
                      className={
                        instruction.limitation === null
                          ? "rounded border border-zinc-800 bg-zinc-900/50 p-3 text-sm leading-relaxed text-zinc-200"
                          : "rounded border border-zinc-800/60 bg-zinc-900/30 p-3 text-sm leading-relaxed text-zinc-400"
                      }
                    >
                      <span className="mr-2 font-mono text-xs text-zinc-400">
                        {index + 1}.
                      </span>
                      {instruction.text}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
