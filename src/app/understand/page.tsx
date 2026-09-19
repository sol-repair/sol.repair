"use client";

/**
 * Transaction explainer (UNDERSTAND, M2). Paste a transaction signature,
 * read what the transaction did in plain language.
 *
 * Read-only forever, by owner lock: this page never connects a wallet
 * and never asks you to sign anything. It reuses the fee ledger's fetch
 * and decoder (base64, version-1 capable) and the explain module's
 * plain-language dictionary; anything the dictionary does not know says
 * so instead of guessing.
 *
 * Quiet for now: nothing links here and the page stays out of the
 * sitemap until the suite is announced (M4).
 */

import { useState } from "react";
import Link from "next/link";
import { NetworkBadge } from "@/components/NetworkBadge";
import { IS_MAINNET } from "@/lib/solana/connection";
import {
  FEE_LEDGER_ENDPOINTS,
  decodeRawTransaction,
  fetchRawTransaction,
  formatBlockTime,
} from "@/lib/solana/feeLedger";
import { explainDecodedTransaction } from "@/lib/solana/explain";
import type { ExplainedTransaction } from "@/lib/solana/explain";

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

type ExplainState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "not-found" }
  | { kind: "unreadable" }
  | { kind: "error"; detail: string }
  | { kind: "done"; signature: string; explained: ExplainedTransaction };

const ENDPOINT = IS_MAINNET
  ? FEE_LEDGER_ENDPOINTS["mainnet-beta"]
  : FEE_LEDGER_ENDPOINTS.devnet;

export default function UnderstandPage() {
  const [signature, setSignature] = useState("");
  const [state, setState] = useState<ExplainState>({ kind: "idle" });

  async function explain(signatureInput: string) {
    if (!SIGNATURE_PATTERN.test(signatureInput)) {
      setState({ kind: "invalid" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const raw = await fetchRawTransaction(ENDPOINT, signatureInput);
      if (!raw) {
        setState({ kind: "not-found" });
        return;
      }
      const decoded = decodeRawTransaction(raw);
      if (!decoded) {
        setState({ kind: "unreadable" });
        return;
      }
      setState({
        kind: "done",
        signature: signatureInput,
        explained: explainDecodedTransaction(decoded),
      });
    } catch (error) {
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
          <span className="font-mono text-sm text-zinc-500">SOL.repair</span>
          <div className="flex items-center gap-3">
            <NetworkBadge />
            <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-300">
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
          plain language. Read-only: this page never connects a wallet and
          never asks you to sign anything. Anything it cannot describe says
          so instead of guessing.
        </p>

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
            className="w-full flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
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
          <p className="mb-6 text-sm text-zinc-400">Reading the chain...</p>
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
            <p className="mt-1 break-all text-xs text-zinc-500">
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
              <p className="mt-2 text-xs text-zinc-500">
                Signed {formatBlockTime(state.explained.blockTime)}
              </p>
            </div>
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
                      : "rounded border border-zinc-800/60 bg-zinc-900/30 p-3 text-sm leading-relaxed text-zinc-500"
                  }
                >
                  <span className="mr-2 font-mono text-xs text-zinc-500">
                    {index + 1}.
                  </span>
                  {instruction.text}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </main>
  );
}
