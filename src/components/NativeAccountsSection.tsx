"use client";

/**
 * NativeAccountsSection (G.3): presentation and per-item consent for
 * wrapped-SOL unwrap+close (spec §6).
 *
 * Renders only when the scan contains eligible native accounts. The
 * component owns the confirmation card and result cards; the
 * authoritative gate, signing, submission, resolution, and
 * verification live in useUnwrapNative. The pre-card read here is
 * presentation only — the hook re-runs the gate as its authoritative
 * first step, in-lock.
 *
 * Copy rules (spec §6.3, test-enforced): findings, never verdicts; the
 * recovery figure is the account's total lamports, never a rent/
 * balance split; no unconditional balance-increase claims; no causal
 * attribution; no success wording while pending or unverified.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";

import { SOLANA_NETWORK } from "@/lib/solana/connection";
import { useUnwrapNative } from "@/hooks/useUnwrapNative";
import {
  ALREADY_CLOSED_COPY,
  buildUnwrapInstruction,
  evaluateNativeGate,
  NATIVE_GATE_ABORT_COPY,
  readNativeAccountState,
  selectUnwrappableNativeAccounts,
  type NativeAccountRead,
  type UnwrappableNativeAccount,
} from "@/lib/solana/unwrapNative";
import { buildTransaction, estimateNetworkFee } from "@/lib/solana/transactions";
import {
  TOKEN_2022_PROGRAM_ID,
  lamportsToSol,
  type ScanResult,
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

function groupCount(value: number): string {
  return groupDigits(value.toString());
}

/** Ticking elapsed-seconds counter (the page's honest "not stuck"
 *  signal, re-declared locally). */
function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums text-zinc-400">
      {seconds}s
    </span>
  );
}

const AMBER_STATUSES = new Set(["checking-current-state", "confirming"]);

function UnwrapSpinner({ amber = false }: { amber?: boolean }) {
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
  | {
      state: "pass";
      amountBeforeAction: string;
      lamportsBeforeAction: number;
      delegate: string | null;
    }
  | { state: "already-closed" }
  | { state: "abort"; sentence: string };

const NO_SIM = { state: "idle" } as const;

/** The wrapped-balance fragment of a row: the funded case states the
 *  scan-time balance and decimals; the empty case states the zero as
 *  the derivation it is (spec §4.2 E6, §5.2 — no balance field exists
 *  at that skip site). */
function wrappedBalanceFragment(candidate: UnwrappableNativeAccount) {
  if (candidate.decimals === undefined) {
    return "wrapped balance 0 (the scan's zero-balance check)";
  }
  return `wrapped balance ${groupDigits(candidate.amountAtScan)} base units (${candidate.decimals} decimals, at scan time)`;
}

export function NativeAccountsSection({
  scan,
  rescan,
  repairInFlight,
  revokeInFlight,
  onActionInFlightChange,
}: {
  scan: ScanResult;
  rescan: () => void;
  repairInFlight: boolean;
  revokeInFlight: boolean;
  onActionInFlightChange?: (inFlight: boolean) => void;
}) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const {
    status,
    outcome,
    signatures,
    accountPubkey,
    lamportsBeforeAction,
    accountPresentAfterAction,
    note,
    error,
    errorDetail,
    actionInFlight,
    unwrap,
    reset,
  } = useUnwrapNative();

  const natives = useMemo(
    () => selectUnwrappableNativeAccounts(scan),
    [scan]
  );

  // Report the in-flight signal upward so the page can hold the repair
  // button and DelegationSection can hold its buttons (the affordance
  // half of §8.11; the mutex is the guarantee).
  useEffect(() => {
    onActionInFlightChange?.(actionInFlight);
  }, [actionInFlight, onActionInFlightChange]);

  const [reviewing, setReviewing] =
    useState<UnwrappableNativeAccount | null>(null);
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
    (c: UnwrappableNativeAccount) => {
      setReviewing(c);
      setGatePreview({ state: "reading" });
      setSim(NO_SIM);
      // Presentation-only pre-card read; the hook re-runs the gate as
      // its authoritative in-lock first step.
      readNativeAccountState(connection, c.pubkey)
        .then((read: NativeAccountRead) => {
          setGatePreview((prev) => {
            if (prev.state !== "reading" || !publicKey) return prev;
            const verdict = evaluateNativeGate(
              read,
              c.mint,
              publicKey.toBase58()
            );
            if (verdict.kind === "pass") {
              return {
                state: "pass",
                amountBeforeAction: verdict.amountBeforeAction,
                lamportsBeforeAction: verdict.lamportsBeforeAction,
                delegate: verdict.delegate,
              };
            }
            if (verdict.kind === "already-closed") {
              return { state: "already-closed" };
            }
            return {
              state: "abort",
              sentence: NATIVE_GATE_ABORT_COPY[verdict.reason],
            };
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
      const candidate: UnwrappableNativeAccount =
        gatePreview.state === "pass" && gatePreview.delegate
          ? { ...reviewing, delegate: gatePreview.delegate }
          : gatePreview.state === "pass"
            ? { ...reviewing, delegate: undefined }
            : reviewing;
      const instructions = buildUnwrapInstruction(candidate, publicKey);
      const transaction = await buildTransaction(connection, publicKey, [
        ...instructions,
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
  }, [connection, publicKey, reviewing, gatePreview]);

  // The raw preview, built from the same instruction objects the hook
  // signs (§6.2 block 4, §7.8 review gate). Field naming is distinct
  // from the page's close preview and DelegationSection's revoke
  // preview.
  const previewEntries = useMemo(() => {
    if (!reviewing || !publicKey || gatePreview.state !== "pass") {
      return null;
    }
    const candidate: UnwrappableNativeAccount = gatePreview.delegate
      ? { ...reviewing, delegate: gatePreview.delegate }
      : { ...reviewing, delegate: undefined };
    return buildUnwrapInstruction(candidate, publicKey).map((ix) => {
      const program = ix.programId.equals(TOKEN_2022_PROGRAM_ID)
        ? "Token-2022 Program"
        : "SPL Token Program";
      if (ix.data[0] === 5) {
        return {
          program,
          instruction: "revoke",
          account: ix.keys[0].pubkey.toBase58(),
          authority: ix.keys[1].pubkey.toBase58(),
          note: "clears the delegate before the close",
        };
      }
      return {
        program,
        instruction: "closeAccount",
        account: ix.keys[0].pubkey.toBase58(),
        destination: ix.keys[1].pubkey.toBase58(),
        authority: ix.keys[2].pubkey.toBase58(),
        note: "every lamport in the account goes to the destination",
      };
    });
  }, [reviewing, publicKey, gatePreview]);

  if (natives.length === 0) {
    return null;
  }

  const busy = actionInFlight;
  const otherActionInFlight = repairInFlight || revokeInFlight;

  return (
    <div
      data-testid="native-accounts-section"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
    >
      <p className="text-sm text-zinc-300">Wrapped SOL</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        {natives.length} {plural(natives.length, "account", "accounts")}{" "}
        {natives.length === 1 ? "holds" : "hold"} wrapped SOL (a
        token-program representation of SOL). Closing{" "}
        {natives.length === 1 ? "it" : "them"} returns every lamport{" "}
        {natives.length === 1 ? "it holds" : "they hold"} to your
        wallet. This is what the chain records; SOL.REPAIR cannot tell
        why{" "}
        {natives.length === 1
          ? "this account exists"
          : "these accounts exist"}{" "}
        or whether anything still expects{" "}
        {natives.length === 1 ? "it" : "them"}.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        Balances and lamports are from the scan (finalized view). Only
        accounts the scan could confirm as wrapped-SOL are offered here;
        an account whose native status the scan could not confirm is
        never offered.
      </p>

      <div className="mt-3 space-y-2">
        {natives.map((c) => (
          <div
            key={c.pubkey}
            className="rounded-md border border-zinc-800 bg-black/40 p-2"
          >
            <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] leading-relaxed text-zinc-400">
              <span className="min-w-0 break-all">
                <AccountLink address={c.pubkey} />
                {" · native mint "}
                <AccountLink address={c.mint} />
                <br />
                {wrappedBalanceFragment(c)} · account holds{" "}
                {groupCount(c.lamports)} lamports total ·{" "}
                {c.program === "token-2022" ? "Token-2022" : "SPL Token Program"}
              </span>
              <button
                onClick={() => beginReview(c)}
                disabled={otherActionInFlight || busy}
                className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Unwrap and close
              </button>
            </div>
            <details className="mt-1">
              <summary className="cursor-pointer text-[11px] text-zinc-500 transition-colors hover:text-zinc-300">
                What closing this account means
              </summary>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                This account is a wrapped-SOL account: a normal token
                account whose token is SOL itself. Swaps and other
                programs open one, use it, and often leave it behind.
                Closing it deletes the account and sends every lamport
                it holds — the wrapped SOL balance and everything else
                in the account, including any SOL that was sent to its
                address directly — to your wallet. That movement is how
                the token program&rsquo;s close works for native
                accounts; SOL.REPAIR does not perform any transfer of
                its own. If a program you use still expects this account
                to exist (some positions and orders are held in wrapped
                SOL), that program will see the account gone after the
                close. SOL.REPAIR cannot tell a leftover wrapper from an
                account something still depends on — that judgment is
                yours. Closing is not undoable by this tool; a future
                swap can open a new wrapped-SOL account (and lock a new
                rent reserve) at any time.
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
          {gatePreview.state === "already-closed" && (
            <>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                {ALREADY_CLOSED_COPY}
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
                You are about to approve 1 transaction that closes
                wrapped-SOL account {short(reviewing.pubkey)}. Every
                lamport it holds —{" "}
                {groupCount(gatePreview.lamportsBeforeAction)} at the
                fresh read just now — goes to your wallet (
                {publicKey ? short(publicKey.toBase58()) : ""}). The
                account will no longer exist.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Wrapped balance at scan:{" "}
                {groupDigits(reviewing.amountAtScan)} base units. At the
                fresh read just now:{" "}
                {groupDigits(gatePreview.amountBeforeAction)} base units.
                Total lamports at scan: {groupCount(reviewing.lamports)}.
                At the fresh read just now:{" "}
                {groupCount(gatePreview.lamportsBeforeAction)}.
              </p>
              {(gatePreview.amountBeforeAction !== reviewing.amountAtScan ||
                gatePreview.lamportsBeforeAction !==
                  reviewing.lamports) && (
                <p className="mt-1 text-xs leading-relaxed text-amber-400/90">
                  The account changed between the scan and this read.
                  SOL.REPAIR cannot tell what caused the change.
                </p>
              )}
              {gatePreview.delegate && (
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                  A delegate ({short(gatePreview.delegate)}) holds a
                  spending permission on this account.
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                This transaction contains exactly{" "}
                {gatePreview.delegate ? "two instructions" : "one instruction"}
                :{" "}
                {gatePreview.delegate
                  ? "a revoke, then closeAccount"
                  : "closeAccount"}
                , from{" "}
                {reviewing.program === "token-2022"
                  ? "the Token-2022 program"
                  : "the SPL Token Program"}
                , with your wallet as both the destination and the
                authority. It does not transfer tokens to any other
                address.
                {gatePreview.delegate &&
                  " It first revokes the delegate on this account, then closes it."}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Network fee: ~{lamportsToSol(estimateNetworkFee())} SOL,
                paid from your wallet. Your wallet may add its own
                priority fee. No service fee: you are recovering your
                own SOL.
              </p>
              <details className="mt-2 rounded-md border border-zinc-800 p-2">
                <summary className="cursor-pointer text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                  Inspect exactly what you&rsquo;ll sign
                </summary>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                  Built from the same instructions the wallet will sign.
                </p>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-black p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
                  {previewEntries && JSON.stringify(previewEntries, null, 2)}
                </pre>
              </details>
              <div className="mt-2">
                <button
                  onClick={runSimulation}
                  disabled={sim.state === "running"}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
                >
                  {sim.state === "running"
                    ? "Simulating on-chain..."
                    : "Run pre-sign simulation"}
                </button>
                {sim.state === "ok" && (
                  <p className="mt-1 text-xs leading-relaxed text-emerald-400">
                    Simulation passed. Expected effect: the account is
                    deleted and every lamport it holds goes to your
                    wallet.
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
                    void unwrap(reviewing);
                  }}
                  className="flex-1 rounded-lg bg-[#14F195] px-4 py-2.5 font-medium text-black transition-colors hover:bg-[#0fd584]"
                >
                  Unwrap and close
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
            <UnwrapSpinner amber={AMBER_STATUSES.has(status)} />
            <p className="min-w-0 flex-1 text-sm text-zinc-300">
              {status === "checking-current-state" &&
                "Checking the account's current state..."}
              {status === "building" && "Building transaction..."}
              {status === "awaiting-signature" &&
                "Check your wallet. Approve to unwrap and close."}
              {status === "sending" && "Approved. Sending to the network..."}
              {status === "confirming" &&
                "Sent. Waiting for the network to confirm..."}
              {status === "verifying" &&
                "Confirmed. Verifying the account is gone on-chain..."}
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
          {outcome === "unwrap-verified" && (
            <>
              <p className="text-sm font-medium text-emerald-400">
                Wrapped SOL returned.
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Wrapped-SOL account {accountPubkey ? short(accountPubkey) : ""}{" "}
                no longer exists — confirmed by a fresh read after the
                transaction. Its last recorded lamports (
                {lamportsBeforeAction === null
                  ? "figure unavailable"
                  : groupCount(lamportsBeforeAction)}
                , read just before the close) went to your wallet as the
                close&rsquo;s destination.
              </p>
            </>
          )}
          {outcome === "already-closed" && (
            <p className="text-sm leading-relaxed text-zinc-300">
              {error}
            </p>
          )}
          {outcome === "close-unattributed" && (
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
          <p className="font-medium">The unwrap did not go through</p>
          <p className="mt-1 leading-relaxed text-red-400/80">{error}</p>
          {outcome === "on-chain-failure" &&
            accountPresentAfterAction === true && (
              <p className="mt-1 text-xs leading-relaxed text-red-400/70">
                When we checked, the account still existed.
              </p>
            )}
          {outcome === "on-chain-failure" &&
            accountPresentAfterAction === false && (
              <p className="mt-1 text-xs leading-relaxed text-red-400/70">
                A fresh read after it shows the account gone — whether
                this app&rsquo;s transaction caused that could not be
                established.
              </p>
            )}
          {outcome === "on-chain-failure" &&
            accountPresentAfterAction === null && (
              <p className="mt-1 text-xs leading-relaxed text-red-400/70">
                The follow-up read failed, so the current state of the
                account is unknown.
              </p>
            )}
          {signatures.map((sig) => (
            <ExplorerLink key={sig} signature={sig} />
          ))}
          {errorDetail && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-red-400/60">
                Technical details
              </summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-xs text-red-400/50">
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
          <p className="font-medium">We could not verify whether the close landed</p>
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
