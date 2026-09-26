"use client";

/**
 * ExcessSection (G.4): presentation and per-item consent for the
 * excess-lamport withdrawal (docs/g4-excess-lamports-spec-draft.md,
 * Revision 1).
 *
 * Detection runs on mount over the scan's Token-2022 keys (chunked
 * batched reads); the section renders nothing while detecting and nothing when
 * no candidate exists. The component owns the confirmation card and
 * result cards; the authoritative gate, signing, submission,
 * resolution, and verification live in useWithdrawExcess.
 *
 * Copy rules: findings, never verdicts; no fee exists and the card
 * says so; the account REMAINS after the action, so no gone-account
 * language in the success card; no em-dashes, no emojis, no
 * exclamation marks.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useRpcConnection } from "@/hooks/useRpcConnection";
import { VersionedTransaction } from "@solana/web3.js";

import { useWithdrawExcess } from "@/hooks/useWithdrawExcess";
import {
  collectToken2022Keys,
  detectExcessCandidates,
  evaluateExcessGate,
  buildWithdrawExcessInstruction,
  readExcessState,
  type ExcessCandidate,
  type ExcessRead,
} from "@/lib/solana/excessLamports";
import { buildTransaction, estimateNetworkFee } from "@/lib/solana/transactions";
import {
  lamportsToSol,
  type ScanResult,
} from "@/lib/solana/tokenAccounts";

function groupCount(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Ticking elapsed-seconds counter. aria-hidden: it sits inside the
 *  role="status" card; a per-second number would re-announce the whole
 *  live region every tick. */
function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      aria-hidden="true"
      className="shrink-0 font-mono text-xs tabular-nums text-zinc-400"
    >
      {seconds}s
    </span>
  );
}

const AMBER_STATUSES = new Set(["checking-current-state", "confirming"]);

function ExcessSpinner({ amber = false }: { amber?: boolean }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none ${
        amber ? "text-amber-400" : "text-emerald-400"
      }`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

type GatePreview =
  | { state: "idle" }
  | { state: "reading" }
  | { state: "pass"; excessBeforeAction: number; lamportsBeforeAction: number }
  | { state: "already-withdrawn" }
  | { state: "already-gone" }
  | { state: "abort"; sentence: string };

export function ExcessSection({
  scan,
  rescan,
  repairInFlight,
  revokeInFlight,
  unwrapInFlight,
  burnInFlight,
  onActionInFlightChange,
}: {
  scan: ScanResult;
  rescan: () => void;
  repairInFlight: boolean;
  revokeInFlight: boolean;
  unwrapInFlight: boolean;
  burnInFlight: boolean;
  onActionInFlightChange?: (inFlight: boolean) => void;
}) {
  const connection = useRpcConnection();
  const { publicKey } = useWallet();
  const {
    status,
    outcome,
    signatures,
    accountPubkey,
    excessBeforeAction,
    lamportsBeforeAction,
    lamportsAfterAction,
    note,
    error,
    errorDetail,
    actionInFlight,
    withdraw,
    reset,
  } = useWithdrawExcess();

  const keys = useMemo(() => collectToken2022Keys(scan), [scan]);

  const [candidates, setCandidates] = useState<ExcessCandidate[] | null>(
    null
  );

  // Detection: chunked batched reads on mount and on every fresh scan. A
  // failed detection renders nothing this round; a rescan retries it.
  useEffect(() => {
    let cancelled = false;
    setCandidates(null);
    detectExcessCandidates(connection, keys)
      .then((found) => {
        if (!cancelled) setCandidates(found);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, keys]);

  const {
    status: detectionStatus,
  } = { status: candidates === null ? "detecting" : "done" };

  // Report the in-flight signal upward (the affordance half; the
  // mutex is the guarantee).
  useEffect(() => {
    onActionInFlightChange?.(actionInFlight);
  }, [actionInFlight, onActionInFlightChange]);

  const [reviewing, setReviewing] = useState<ExcessCandidate | null>(null);
  const [gatePreview, setGatePreview] = useState<GatePreview>({
    state: "idle",
  });
  const [sim, setSim] = useState<
    | { state: "idle" }
    | { state: "running" }
    | { state: "ok" }
    | { state: "error"; error: string }
  >({ state: "idle" });

  const beginReview = useCallback(
    (c: ExcessCandidate) => {
      setReviewing(c);
      setGatePreview({ state: "reading" });
      setSim({ state: "idle" });
      readExcessState(connection, c.pubkey)
        .then((read: ExcessRead) => {
          setGatePreview((prev) => {
            if (prev.state !== "reading" || !publicKey) return prev;
            const verdict = evaluateExcessGate(read, c);
            if (verdict.kind === "pass") {
              return {
                state: "pass",
                excessBeforeAction: verdict.excessBeforeAction,
                lamportsBeforeAction: verdict.lamportsBeforeAction,
              };
            }
            if (verdict.kind === "already-withdrawn") {
              return { state: "already-withdrawn" };
            }
            if (verdict.kind === "already-gone") {
              return { state: "already-gone" };
            }
            return { state: "abort", sentence: verdict.sentence };
          });
        })
        .catch(() => {
          setGatePreview((prev) =>
            prev.state === "reading"
              ? {
                  state: "abort",
                  sentence:
                    "The current account state could not be read. Nothing was signed.",
                }
              : prev
          );
        });
    },
    [connection, publicKey]
  );

  const closeReview = useCallback(() => {
    setReviewing(null);
    setGatePreview({ state: "idle" });
    setSim({ state: "idle" });
  }, []);

  const finishAction = useCallback(() => {
    reset();
    closeReview();
    rescan();
  }, [reset, closeReview, rescan]);

  const runSimulation = useCallback(async () => {
    if (!reviewing || !publicKey) return;
    setSim({ state: "running" });
    try {
      const transaction = await buildTransaction(connection, publicKey, [
        buildWithdrawExcessInstruction(reviewing, publicKey),
      ]);
      const versioned = new VersionedTransaction(
        transaction.compileMessage()
      );
      const res = await connection.simulateTransaction(versioned, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      if (res.value.err) {
        throw new Error(JSON.stringify(res.value.err));
      }
      setSim({ state: "ok" });
    } catch (e) {
      setSim({
        state: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [connection, publicKey, reviewing]);

  const previewEntries = useMemo(() => {
    if (!reviewing || !publicKey) return null;
    const ix = buildWithdrawExcessInstruction(reviewing, publicKey);
    return [
      {
        program: "Token-2022 Program",
        instruction: "withdrawExcessLamports",
        account: ix.keys[0].pubkey.toBase58(),
        destination: ix.keys[1].pubkey.toBase58(),
        authority: ix.keys[2].pubkey.toBase58(),
        note: "every lamport above the account's required deposit goes to the destination",
      },
    ];
  }, [reviewing, publicKey]);

  if (detectionStatus === "detecting" || !candidates || candidates.length === 0) {
    return null;
  }

  const busy = actionInFlight;
  const otherActionInFlight =
    repairInFlight || revokeInFlight || unwrapInFlight || burnInFlight;

  return (
    <div
      data-testid="excess-section"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
    >
      <p className="text-sm text-zinc-300">Excess lamports</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        {candidates.length}{" "}
        {candidates.length === 1 ? "account holds" : "accounts hold"} more
        lamports than its rent deposit requires. Withdrawing the spare
        lamports moves them to your wallet; the account stays open with
        exactly its required deposit. There is no service fee: the spare
        lamports are your own SOL.
      </p>

      <div className="mt-3 space-y-2">
        {candidates.map((c) => (
          <div
            key={c.pubkey}
            className="rounded-md border border-zinc-800 bg-black/40 p-2"
          >
            <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] leading-relaxed text-zinc-400">
              <span className="min-w-0 break-all">
                {short(c.pubkey)}
                {c.mint ? <> · mint {short(c.mint)}</> : null}
                <br />
                holds {groupCount(c.lamports)} lamports ·{" "}
                {groupCount(c.excess)} above its deposit · Token-2022
                {c.frozen ? " · frozen" : ""}
              </span>
              <button
                onClick={() => beginReview(c)}
                disabled={otherActionInFlight || busy}
                className="shrink-0 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Withdraw excess
              </button>
            </div>
            <details className="mt-1">
              <summary className="cursor-pointer py-1 text-[11px] text-zinc-400 transition-colors hover:text-zinc-300">
                What withdrawing excess lamports means
              </summary>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                A token account must hold a rent deposit, but it can end
                up holding more than it needs. This action moves the
                spare lamports to your wallet; the account stays open
                with exactly its required deposit. No tokens move, no
                account closes, and the deposit itself stays where it
                is. The withdrawal is one instruction the Token-2022
                program provides for exactly this purpose.
              </p>
            </details>
          </div>
        ))}
      </div>

      {otherActionInFlight && !busy && (
        <p className="mt-3 text-xs leading-relaxed text-amber-400/80">
          Another wallet action is underway. Wait for it to finish.
        </p>
      )}

      {/* Confirmation card. The pre-card read is presentation; the
          hook re-runs the gate authoritatively. */}
      {reviewing && status === "idle" && (
        <div className="mt-3 rounded-md border border-zinc-700 p-3">
          <p className="text-sm font-medium text-zinc-200">
            Review before you sign
          </p>
          {gatePreview.state === "reading" && (
            <p className="mt-2 text-xs text-zinc-400">
              Reading the account&rsquo;s current state...
            </p>
          )}
          {gatePreview.state === "abort" && (
            <>
              <p className="mt-2 text-xs leading-relaxed text-amber-400">
                {gatePreview.sentence}
              </p>
              <div className="mt-3 flex gap-3">
                <button
                  onClick={() => {
                    closeReview();
                    rescan();
                  }}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  Rescan
                </button>
                <button
                  onClick={closeReview}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  Close
                </button>
              </div>
            </>
          )}
          {gatePreview.state === "already-withdrawn" && (
            <>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                The account holds no excess lamports now. Nothing was
                signed.
              </p>
              <div className="mt-3">
                <button
                  onClick={() => {
                    closeReview();
                    rescan();
                  }}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  Close
                </button>
              </div>
            </>
          )}
          {gatePreview.state === "already-gone" && (
            <>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                This account no longer exists. Nothing was signed.
              </p>
              <div className="mt-3">
                <button
                  onClick={() => {
                    closeReview();
                    rescan();
                  }}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  Close
                </button>
              </div>
            </>
          )}
          {gatePreview.state === "pass" && (
            <>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                You are about to approve 1 transaction that withdraws{" "}
                {groupCount(gatePreview.excessBeforeAction)} spare
                lamports from token account{" "}
                {short(reviewing.pubkey)} to your wallet (
                {publicKey ? short(publicKey.toBase58()) : ""}). The
                account stays open with exactly its required deposit. No
                tokens move and no account closes.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Total lamports at detection:{" "}
                {groupCount(reviewing.lamports)}. At the fresh read just
                now: {groupCount(gatePreview.lamportsBeforeAction)}.
                Spare lamports at the fresh read just now:{" "}
                {groupCount(gatePreview.excessBeforeAction)}.
              </p>
              {gatePreview.excessBeforeAction !== reviewing.excess && (
                <p className="mt-1 text-xs leading-relaxed text-amber-400/90">
                  The excess figure changed between detection and this
                  read. The withdrawal takes whatever excess exists when
                  the transaction lands. SOL.REPAIR cannot tell what
                  caused the change.
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                This transaction contains exactly one instruction:
                withdrawExcessLamports, from the Token-2022 program, with
                your wallet as the destination and the authority. There
                is no service fee. Your wallet may add its own priority
                fee, and the network fee is ~
                {lamportsToSol(estimateNetworkFee())} SOL.
              </p>
              <details className="mt-2 rounded-md border border-zinc-800 p-2">
                <summary className="cursor-pointer py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                  Inspect exactly what you&rsquo;ll sign
                </summary>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                  Built from the same instruction the wallet will sign.
                </p>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-black p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
                  {previewEntries && JSON.stringify(previewEntries, null, 2)}
                </pre>
              </details>
              <div className="mt-2">
                <button
                  onClick={runSimulation}
                  disabled={sim.state === "running"}
                  className="rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
                >
                  {sim.state === "running"
                    ? "Simulating on-chain..."
                    : "Run pre-sign simulation"}
                </button>
                {sim.state === "ok" && (
                  <p className="mt-1 text-xs leading-relaxed text-emerald-400">
                    Simulation passed. Expected effect: the spare
                    lamports move to your wallet and the account stays
                    open with exactly its deposit.
                  </p>
                )}
                {sim.state === "error" && (
                  <p className="mt-1 text-xs leading-relaxed text-red-400">
                    Simulation failed: {sim.error}
                  </p>
                )}
              </div>
              <div className="mt-3 flex gap-3">
                <button
                  onClick={() => {
                    void withdraw(reviewing);
                  }}
                  className="flex-1 rounded-lg bg-[#14F195] px-4 py-2.5 font-medium text-black transition-colors hover:bg-[#0fd584]"
                >
                  Withdraw excess
                </button>
                <button
                  onClick={closeReview}
                  className="rounded-lg border border-zinc-700 px-4 py-2.5 text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* In-flight card */}
      {status !== "idle" &&
        status !== "done" &&
        status !== "error" &&
        status !== "unverified" && (
          <div
            role="status"
            className="mt-3 rounded-md border border-zinc-700 p-3"
          >
            <div className="flex items-center gap-3">
              <ExcessSpinner amber={AMBER_STATUSES.has(status)} />
              <p className="min-w-0 flex-1 text-sm text-zinc-300">
                {status === "checking-current-state" &&
                  "Checking the account's current state..."}
                {status === "building" && "Building transaction..."}
                {status === "awaiting-signature" &&
                  "Check your wallet. Approve to withdraw the excess."}
                {status === "sending" &&
                  "Approved. Sending to the network..."}
                {status === "confirming" &&
                  "Sent. Waiting for the network to confirm..."}
                {status === "verifying" &&
                  "Confirmed. Verifying the account's lamports on-chain..."}
              </p>
              {(status === "sending" ||
                status === "confirming" ||
                status === "verifying") && <ElapsedSeconds />}
            </div>
            {note && (
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                {note}
              </p>
            )}
          </div>
        )}

      {/* Done cards */}
      {status === "done" && (
        <div className="mt-3 rounded-md border border-emerald-800 bg-emerald-950/30 p-3">
          {outcome === "withdraw-verified" && (
            <>
              <p className="text-sm font-medium text-emerald-400">
                Excess lamports withdrawn.
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Token account {accountPubkey ? short(accountPubkey) : ""}{" "}
                now holds{" "}
                {lamportsAfterAction === null
                  ? "figure unavailable"
                  : `${groupCount(lamportsAfterAction)} lamports`}
                , confirmed by a fresh read after the transaction. The
                spare{" "}
                {excessBeforeAction === null
                  ? "figure unavailable"
                  : groupCount(excessBeforeAction)}{" "}
                lamports went to your wallet, and the account remains
                open with its deposit.
              </p>
            </>
          )}
          {outcome === "already-withdrawn" && (
            <p className="text-sm leading-relaxed text-zinc-300">
              {error}
            </p>
          )}
          {outcome === "already-gone" && (
            <p className="text-sm leading-relaxed text-zinc-300">
              {error}
            </p>
          )}
          {outcome === "unattributed" && (
            <p className="text-sm leading-relaxed text-zinc-300">
              {error}
            </p>
          )}
          {signatures.map((sig) => (
            <p
              key={sig}
              className="mt-2 break-all font-mono text-xs text-zinc-400"
            >
              Signature: {sig}
            </p>
          ))}
          <div className="mt-3">
            <button
              onClick={finishAction}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Error card */}
      {status === "error" && (
        <div className="mt-3 rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-400">
          <p className="font-medium">The withdrawal did not go through</p>
          <p className="mt-1 leading-relaxed text-red-400">{error}</p>
          {signatures.map((sig) => (
            <p
              key={sig}
              className="mt-2 break-all font-mono text-xs text-red-400"
            >
              Signature: {sig}
            </p>
          ))}
          {errorDetail && (
            <details className="mt-2">
              <summary className="cursor-pointer py-1 text-xs text-red-400">
                Technical details
              </summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-xs text-red-400">
                {errorDetail}
              </pre>
            </details>
          )}
          <button
            onClick={finishAction}
            className="mt-3 rounded-lg border border-zinc-700 px-4 py-2 text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Unverified card */}
      {status === "unverified" && (
        <div className="mt-3 rounded-md border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-300">
          <p className="font-medium">
            We could not verify whether the withdrawal landed
          </p>
          <p className="mt-1 leading-relaxed text-amber-300/80">
            {error}
          </p>
          {signatures.map((sig) => (
            <p
              key={sig}
              className="mt-2 break-all font-mono text-xs text-amber-300/80"
            >
              Signature: {sig}
            </p>
          ))}
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              onClick={() => {
                // A read-only resolution attempt: never a submission.
                rescan();
              }}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Rescan to check the current state
            </button>
            <button
              onClick={finishAction}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
