"use client";

/**
 * DelegationSection (G.2): presentation and per-item consent for
 * funded-account delegate revocation (spec §6).
 *
 * Renders only when the scan contains eligible delegations (plus
 * read-only rows for frozen delegated accounts). The component owns
 * the confirmation card and result cards; the authoritative gate,
 * signing, submission, resolution, and verification live in
 * useRevokeDelegate. The pre-card read here is presentation only —
 * the hook re-runs the gate as its authoritative first step, in-lock.
 *
 * Copy rules (spec §6.3, test-enforced): findings, never verdicts; no
 * unconditional balance claims (only the recorded reads), no causal
 * attribution, no allowance figures, no success wording while pending
 * or unverified.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useRpcConnection } from "@/hooks/useRpcConnection";
import { VersionedTransaction } from "@solana/web3.js";

import { SOLANA_NETWORK } from "@/lib/solana/connection";
import { useRevokeDelegate } from "@/hooks/useRevokeDelegate";
import {
  ALREADY_REVOKED_COPY,
  buildRevokeInstruction,
  evaluateDelegationGate,
  gateAbortSentence,
  readDelegatedAccountState,
  selectRevocableDelegations,
  type DelegatedAccountRead,
  type RevocableDelegation,
} from "@/lib/solana/revokeDelegation";
import { buildTransaction, estimateNetworkFee } from "@/lib/solana/transactions";
import {
  lamportsToSol,
  type ScanResult,
  type SkippedAccount,
} from "@/lib/solana/tokenAccounts";

const plural = (count: number, singular: string, pluralForm: string) =>
  count === 1 ? singular : pluralForm;

/** Explorer link for an account address (same rules as the page). */
function accountUrl(address: string): string | null {
  if (SOLANA_NETWORK === "mainnet-beta") {
    return `https://solscan.io/account/${address}`;
  }
  if (SOLANA_NETWORK === "devnet") {
    return `https://solscan.io/account/${address}?cluster=devnet`;
  }
  if (SOLANA_NETWORK === "testnet") {
    return `https://solscan.io/account/${address}?cluster=testnet`;
  }
  return null;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function AccountLink({ address }: { address: string }) {
  const href = accountUrl(address);
  if (href === null) {
    return <span title={address}>{short(address)}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
    >
      {short(address)}
    </a>
  );
}

/** Explorer link for a transaction signature. */
function explorerUrl(signature: string): string | null {
  if (SOLANA_NETWORK === "mainnet-beta") {
    return `https://solscan.io/tx/${signature}`;
  }
  if (SOLANA_NETWORK === "devnet") {
    return `https://solscan.io/tx/${signature}?cluster=devnet`;
  }
  if (SOLANA_NETWORK === "testnet") {
    return `https://solscan.io/tx/${signature}?cluster=testnet`;
  }
  return null;
}

function ExplorerLink({ signature }: { signature: string }) {
  const href = explorerUrl(signature);
  if (href === null) {
    return (
      <p className="mt-2 break-all font-mono text-xs text-zinc-400">
        Signature: {signature}
      </p>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 inline-block text-sm text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
    >
      View on Solscan
    </a>
  );
}

/** Thousands grouping for exact base-unit strings (string-safe for
 *  full u64 values, no float rounding). */
function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Ticking elapsed-seconds counter (the page's honest "not stuck"
 *  signal, re-declared locally). aria-hidden: it sits inside the
 *  role="status" card, and a per-second number would re-announce the
 *  whole live region every tick; the status text carries the
 *  meaningful announcements. */
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

function RevokeSpinner({ amber = false }: { amber?: boolean }) {
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

/** The balance-observation block for a verified revocation: derived
 *  ONLY from the hook's three recorded reads (spec §8.2, Cases A-D
 *  plus the both-changed combination). Evidence-dependent by
 *  construction — there is no unconditional "unchanged" branch. */
export function balanceObservationCopy(
  scan: string | null,
  before: string | null,
  after: string | null
): string | null {
  if (scan === null || before === null) return null;
  const g = groupDigits;
  if (after === null) {
    return `Balance at scan: ${g(scan)} base units. Balance in the fresh read before the transaction: ${g(before)}. The post-transaction balance could not be read (the read failed), so the balance result is unknown. The revocation itself is verified; the balance is not.`;
  }
  if (scan === before && before === after) {
    return `Balance observed: ${g(scan)} base units at the scan, in the fresh read before the transaction, and in the read after it. The recorded reads matched. SOL.REPAIR does not monitor the account between reads.`;
  }
  if (scan !== before && before === after) {
    return `Balance at scan: ${g(scan)}. Balance in the fresh read before the transaction: ${g(before)}. Balance in the read after it: ${g(after)}. The change happened before the transaction; SOL.REPAIR cannot tell what caused it.`;
  }
  if (scan === before && before !== after) {
    return `Balance in the fresh read before the transaction: ${g(before)}. Balance in the read after it: ${g(after)}. The balance changed between those two reads. SOL.REPAIR cannot attribute the change and does not claim the transaction caused it.`;
  }
  return `Balance at scan: ${g(scan)}. Balance before the transaction: ${g(before)}. Balance after it: ${g(after)}. The balance changed before the transaction and again between the pre-transaction read and the read after it. SOL.REPAIR cannot attribute either change and does not claim the transaction caused them.`;
}

type GatePreview =
  | { state: "idle" }
  | { state: "reading" }
  | { state: "pass"; balanceBeforeAction: string }
  | { state: "already-absent" }
  | { state: "abort"; sentence: string };

const NO_SIM = { state: "idle" } as const;

export function DelegationSection({
  scan,
  rescan,
  repairInFlight,
  unwrapInFlight,
  onActionInFlightChange,
}: {
  scan: ScanResult;
  rescan: () => void;
  repairInFlight: boolean;
  /** G.3 §8.11: the unwrap action's in-flight signal, folded into the
   *  existing affordance; the mutex, not buttons, remains the
   *  guarantee. */
  unwrapInFlight?: boolean;
  onActionInFlightChange?: (inFlight: boolean) => void;
}) {
  const connection = useRpcConnection();
  const { publicKey } = useWallet();
  const {
    status,
    outcome,
    signatures,
    accountPubkey,
    balanceAtScan,
    balanceBeforeAction,
    balanceAfterAction,
    delegatePresentAtLastRead,
    note,
    error,
    errorDetail,
    actionInFlight,
    revoke,
    reset,
  } = useRevokeDelegate();

  const delegations = useMemo(
    () => selectRevocableDelegations(scan),
    [scan]
  );
  const frozenDelegated = useMemo(
    () =>
      scan.skippedAccounts.filter(
        (entry: SkippedAccount) =>
          entry.cause === "funded" &&
          entry.delegated === true &&
          entry.frozen === true
      ),
    [scan]
  );

  // Report the in-flight signal upward so the page can hold the repair
  // button (the affordance half of §8.12; the mutex is the guarantee).
  useEffect(() => {
    onActionInFlightChange?.(actionInFlight);
  }, [actionInFlight, onActionInFlightChange]);

  const [reviewing, setReviewing] = useState<RevocableDelegation | null>(
    null
  );
  const [gatePreview, setGatePreview] = useState<GatePreview>({
    state: "idle",
  });
  const [sim, setSim] = useState<
    | { state: "idle" }
    | { state: "running" }
    | { state: "ok" }
    | { state: "error"; error: string }
  >(NO_SIM);

  const beginReview = useCallback(
    (d: RevocableDelegation) => {
      setReviewing(d);
      setGatePreview({ state: "reading" });
      setSim(NO_SIM);
      // Presentation-only pre-card read; the hook re-runs the gate as
      // its authoritative in-lock first step.
      readDelegatedAccountState(connection, d.pubkey)
        .then((read: DelegatedAccountRead) => {
          setGatePreview((prev) => {
            if (prev.state !== "reading" || !publicKey) return prev;
            const verdict = evaluateDelegationGate(
              read,
              d.delegate,
              publicKey.toBase58()
            );
            if (verdict.kind === "pass") {
              return {
                state: "pass",
                balanceBeforeAction: verdict.balanceBeforeAction,
              };
            }
            if (verdict.kind === "already-absent") {
              return { state: "already-absent" };
            }
            return { state: "abort", sentence: gateAbortSentence(verdict) };
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
    setSim(NO_SIM);
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
      const instruction = buildRevokeInstruction(reviewing, publicKey);
      const transaction = await buildTransaction(connection, publicKey, [
        instruction,
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

  if (delegations.length === 0 && frozenDelegated.length === 0) {
    return null;
  }

  const busy = actionInFlight;
  const otherActionInFlight = repairInFlight || unwrapInFlight === true;

  return (
    <div
      data-testid="delegation-section"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
    >
      <p className="text-sm text-zinc-300">Standing delegations</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        {delegations.length} funded{" "}
        {plural(delegations.length, "account", "accounts")} with a balance{" "}
        {plural(delegations.length, "has", "have")} an active delegation. A
        delegation is a permission the account&rsquo;s owner granted to the
        address shown. This is what the chain records; SOL.REPAIR cannot
        tell why a delegation exists or whether the delegate has ever
        acted.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        Balances and delegate facts are from the scan (finalized view).
        Only accounts the scan could confirm as non-native are offered
        here.
      </p>

      {delegations.length > 0 && (
        <div className="mt-3 space-y-2">
          {delegations.map((d) => (
            <div
              key={d.pubkey}
              className="rounded-md border border-zinc-800 bg-black/40 p-2"
            >
              <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] leading-relaxed text-zinc-400">
                <span className="min-w-0 break-all">
                  <AccountLink address={d.pubkey} />
                  {" · "}
                  <AccountLink address={d.mint} />
                  {d.program === "token-2022" && (
                    <span className="text-sky-400/80"> · Token-2022</span>
                  )}
                  <br />
                  balance {groupDigits(d.balanceAtScan)} base units (
                  {d.decimals} decimals, at scan time) · delegate{" "}
                  <AccountLink address={d.delegate} />
                </span>
                <button
                  onClick={() => beginReview(d)}
                  disabled={otherActionInFlight || busy}
                  className="shrink-0 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Revoke delegate
                </button>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer py-1 text-[11px] text-zinc-400 transition-colors hover:text-zinc-300">
                  What this delegation means
                </summary>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                  This account has an active delegation to the address
                  shown. The token program lets that address spend from
                  this account, by transferring or burning, up to the
                  delegated amount that was set when the permission was
                  created. The amount of delegated spending authority is
                  not displayed: the scan&rsquo;s account data names the
                  delegate but does not include the delegated amount, and
                  SOL.REPAIR does not invent values it cannot read. The
                  delegation does not include closing the account or
                  changing its authorities. Revoking ends this permission
                  going forward. It does not reverse anything that already
                  happened, and it does not change the account&rsquo;s
                  owner or any other authority.
                </p>
              </details>
            </div>
          ))}
        </div>
      )}

      {frozenDelegated.length > 0 && (
        <div className="mt-2 space-y-1 font-mono text-[11px] leading-relaxed text-zinc-400">
          {frozenDelegated.map((entry) => (
            <p key={entry.pubkey} className="break-all">
              <AccountLink address={entry.pubkey} /> · frozen by the
              token&rsquo;s freeze authority; a frozen account cannot be
              revoked
            </p>
          ))}
        </div>
      )}

      {otherActionInFlight && !busy && (
        <p className="mt-3 text-xs leading-relaxed text-amber-400/80">
          Another wallet action is underway. Wait for it to finish.
        </p>
      )}

      {/* Confirmation card (spec §6.2 block 4). The pre-card read is
          presentation; the hook re-runs the gate authoritatively. */}
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
          {gatePreview.state === "already-absent" && (
            <>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                {ALREADY_REVOKED_COPY}
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
                You are about to approve 1 transaction that removes the
                delegate {short(reviewing.delegate)} from token account{" "}
                {short(reviewing.pubkey)}.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Balance at scan: {groupDigits(reviewing.balanceAtScan)} base
                units. Balance at the fresh read just now:{" "}
                {groupDigits(gatePreview.balanceBeforeAction)} base units.
              </p>
              {gatePreview.balanceBeforeAction !==
                reviewing.balanceAtScan && (
                <p className="mt-1 text-xs leading-relaxed text-amber-400/90">
                  The balance changed between the scan and this read.
                  SOL.REPAIR cannot tell what caused the change.
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                This transaction contains exactly one instruction: revoke,
                from{" "}
                {reviewing.program === "token-2022"
                  ? "the Token-2022 program"
                  : "the SPL Token Program"}
                . It does not transfer or burn tokens, does not close the
                account, and does not change the token balance.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Network fee: ~{lamportsToSol(estimateNetworkFee())} SOL, paid
                from your wallet. No service fee: the 1% fee applies only to
                recovered rent, and this transaction recovers none. Your
                wallet may add its own priority fee.
              </p>
              <details className="mt-2 rounded-md border border-zinc-800 p-2">
                <summary className="cursor-pointer py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                  Inspect exactly what you&rsquo;ll sign
                </summary>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                  Built from the same instruction the wallet will sign.
                </p>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-black p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
                  {JSON.stringify(
                    [
                      {
                        program:
                          reviewing.program === "token-2022"
                            ? "Token-2022 Program"
                            : "SPL Token Program",
                        instruction: "revoke",
                        account: reviewing.pubkey,
                        delegateAuthority: publicKey?.toBase58() ?? null,
                        note: "removes the delegate; balance untouched",
                      },
                    ],
                    null,
                    2
                  )}
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
                    Simulation passed. Expected effect: the delegate is
                    cleared; the balance is untouched.
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
                    void revoke(reviewing);
                  }}
                  className="flex-1 rounded-lg bg-[#14F195] px-4 py-2.5 font-medium text-black transition-colors hover:bg-[#0fd584]"
                >
                  Revoke delegate
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
      {status !== "idle" && status !== "done" && status !== "error" && status !== "unverified" && (
        <div
          role="status"
          className="mt-3 rounded-md border border-zinc-700 p-3"
        >
          <div className="flex items-center gap-3">
            <RevokeSpinner amber={AMBER_STATUSES.has(status)} />
            <p className="min-w-0 flex-1 text-sm text-zinc-300">
              {status === "checking-current-state" &&
                "Checking the account's current state..."}
              {status === "building" && "Building transaction..."}
              {status === "awaiting-signature" &&
                "Check your wallet. Approve to revoke the delegate."}
              {status === "sending" && "Approved. Sending to the network..."}
              {status === "confirming" &&
                "Sent. Waiting for the network to confirm..."}
              {status === "verifying" &&
                "Confirmed. Verifying the delegate field on-chain..."}
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
          {outcome === "revoked-verified" && (
            <>
              <p className="text-sm font-medium text-emerald-400">
                Delegate revoked
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Token account {accountPubkey ? short(accountPubkey) : ""} no
                longer names a delegate, confirmed by a fresh read after
                the transaction.
              </p>
              {balanceObservationCopy(
                balanceAtScan,
                balanceBeforeAction,
                balanceAfterAction
              ) && (
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                  {
                    balanceObservationCopy(
                      balanceAtScan,
                      balanceBeforeAction,
                      balanceAfterAction
                    ) as string
                  }
                </p>
              )}
            </>
          )}
          {outcome === "already-revoked" && (
            <p className="text-sm leading-relaxed text-zinc-300">
              {error}
            </p>
          )}
          {outcome === "delegate-absent-unattributed" && (
            <p className="text-sm leading-relaxed text-zinc-300">{error}</p>
          )}
          {signatures.map((sig) => (
            <ExplorerLink key={sig} signature={sig} />
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
          <p className="font-medium">The revoke did not go through</p>
          <p className="mt-1 leading-relaxed text-red-400">{error}</p>
          {outcome === "on-chain-failure" &&
            delegatePresentAtLastRead === true && (
              <p className="mt-1 text-xs leading-relaxed text-red-400">
                When we checked, the delegate was still on the account.
              </p>
            )}
          {outcome === "on-chain-failure" &&
            delegatePresentAtLastRead === false && (
              <p className="mt-1 text-xs leading-relaxed text-red-400">
                A fresh read after it shows no delegate on the account.
                Whether this app&rsquo;s transaction caused that could not
                be established.
              </p>
            )}
          {outcome === "on-chain-failure" &&
            delegatePresentAtLastRead === null && (
              <p className="mt-1 text-xs leading-relaxed text-red-400">
                The follow-up read failed, so the current delegate state is
                unknown.
              </p>
            )}
          {signatures.map((sig) => (
            <ExplorerLink key={sig} signature={sig} />
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

      {/* Unverified card (distinct from success and failure, §8.9) */}
      {status === "unverified" && (
        <div className="mt-3 rounded-md border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-300">
          <p className="font-medium">We could not verify whether the revoke landed</p>
          <p className="mt-1 leading-relaxed text-amber-300/80">{error}</p>
          {signatures.map((sig) => (
            <ExplorerLink key={sig} signature={sig} />
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
