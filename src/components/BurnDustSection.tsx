"use client";

/**
 * BurnDustSection: presentation and per-item consent for the dust
 * burn-and-close action (docs/dust-zeroing-spec-draft.md, Revision 1).
 *
 * Renders only when the scan contains eligible dust accounts. The
 * component owns the confirmation card and result cards; the
 * authoritative gate, signing, submission, resolution, and
 * verification live in useBurnDust. The pre-card read here is
 * presentation only — the hook re-runs the gate as its authoritative
 * first step, in-lock.
 *
 * Copy rules (test-enforced, mirroring G.2/G.3): findings, never
 * verdicts; burning is described as permanent; SOL.REPAIR never judges
 * what a token is worth; no success wording while pending or
 * unverified; no em-dashes, no emojis, no exclamation marks.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useRpcConnection } from "@/hooks/useRpcConnection";
import { VersionedTransaction } from "@solana/web3.js";

import { useBurnDust } from "@/hooks/useBurnDust";
import {
  ALREADY_EMPTY_COPY,
  ALREADY_GONE_COPY,
  BURN_GATE_ABORT_COPY,
  buildBurnDustInstructions,
  evaluateBurnGate,
  readNativeAccountState,
  selectBurnableDustAccounts,
  type BurnableDustAccount,
  type NativeAccountRead,
} from "@/lib/solana/burnDust";
import { buildTransaction, estimateNetworkFee } from "@/lib/solana/transactions";
import { buildFeeTransfer, feeAmountLamports } from "@/lib/solana/fees";
import {
  SOLANA_NETWORK,
} from "@/lib/solana/connection";
import {
  TOKEN_2022_PROGRAM_ID,
  lamportsToSol,
  type ScanResult,
} from "@/lib/solana/tokenAccounts";

const plural = (count: number, singular: string, pluralForm: string) =>
  count === 1 ? singular : pluralForm;

/** Thousands grouping for exact base-unit strings (string-safe for
 *  full u64 values, no float rounding). */
function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function groupCount(value: number): string {
  return groupDigits(value.toString());
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

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

/** Ticking elapsed-seconds counter (the house "not stuck" signal).
 *  aria-hidden: it sits inside the role="status" card, and a
 *  per-second number would re-announce the whole live region every
 *  tick. */
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

function BurnSpinner({ amber = false }: { amber?: boolean }) {
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
      balanceBeforeAction: string;
      lamportsBeforeAction: number;
      delegate: string | null;
    }
  | { state: "already-gone" }
  | { state: "already-empty" }
  | { state: "abort"; sentence: string };

const NO_SIM = { state: "idle" } as const;

export function BurnDustSection({
  scan,
  rescan,
  repairInFlight,
  revokeInFlight,
  unwrapInFlight,
  excessInFlight,
  feeReady,
  onActionInFlightChange,
}: {
  scan: ScanResult;
  rescan: () => void;
  repairInFlight: boolean;
  revokeInFlight: boolean;
  unwrapInFlight: boolean;
  /** The G.4 excess-withdrawal action's in-flight signal. */
  excessInFlight?: boolean;
  feeReady: boolean;
  onActionInFlightChange?: (inFlight: boolean) => void;
}) {
  const connection = useRpcConnection();
  const { publicKey } = useWallet();
  const {
    status,
    outcome,
    signatures,
    accountPubkey,
    balanceBeforeAction,
    accountPresentAfterAction,
    note,
    error,
    errorDetail,
    actionInFlight,
    burn,
    reset,
  } = useBurnDust();

  const dust = useMemo(
    () => selectBurnableDustAccounts(scan),
    [scan]
  );

  // Report the in-flight signal upward so the page can hold the repair
  // button and the other sections can hold their buttons (the
  // affordance half; the mutex is the guarantee).
  useEffect(() => {
    onActionInFlightChange?.(actionInFlight);
  }, [actionInFlight, onActionInFlightChange]);

  const [reviewing, setReviewing] = useState<BurnableDustAccount | null>(
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
    (c: BurnableDustAccount) => {
      setReviewing(c);
      setGatePreview({ state: "reading" });
      setSim(NO_SIM);
      // Presentation-only pre-card read; the hook re-runs the gate as
      // its authoritative in-lock first step.
      readNativeAccountState(connection, c.pubkey)
        .then((read: NativeAccountRead) => {
          setGatePreview((prev) => {
            if (prev.state !== "reading" || !publicKey) return prev;
            const verdict = evaluateBurnGate(
              read,
              c.mint,
              publicKey.toBase58()
            );
            if (verdict.kind === "pass") {
              return {
                state: "pass",
                balanceBeforeAction: verdict.balanceBeforeAction,
                lamportsBeforeAction: verdict.lamportsBeforeAction,
                delegate: verdict.delegate,
              };
            }
            if (verdict.kind === "already-gone") {
              return { state: "already-gone" };
            }
            if (verdict.kind === "already-empty") {
              return { state: "already-empty" };
            }
            return {
              state: "abort",
              sentence: BURN_GATE_ABORT_COPY[verdict.reason],
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
    if (!reviewing || !publicKey || gatePreview.state !== "pass") return;
    setSim({ state: "running" });
    try {
      const instructions = buildBurnDustInstructions(
        {
          ...reviewing,
          amountBeforeAction: gatePreview.balanceBeforeAction,
        },
        publicKey
      );
      if (feeReady) {
        const fee = buildFeeTransfer(publicKey, [
          {
            pubkey: reviewing.pubkey,
            mint: reviewing.mint,
            lamports: gatePreview.lamportsBeforeAction,
            program: reviewing.program,
          },
        ]);
        if (fee) instructions.push(fee);
      }
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
  }, [connection, publicKey, reviewing, gatePreview, feeReady]);

  // The raw preview, built from the same instruction objects the hook
  // signs.
  const previewEntries = useMemo(() => {
    if (!reviewing || !publicKey || gatePreview.state !== "pass") {
      return null;
    }
    const entries: Array<Record<string, string>> = [];
    for (const ix of buildBurnDustInstructions(
      { ...reviewing, amountBeforeAction: gatePreview.balanceBeforeAction },
      publicKey
    )) {
      const program = ix.programId.equals(TOKEN_2022_PROGRAM_ID)
        ? "Token-2022 Program"
        : "SPL Token Program";
      if (ix.data[0] === 9) {
        entries.push({
          program,
          instruction: "closeAccount",
          account: ix.keys[0].pubkey.toBase58(),
          destination: ix.keys[1].pubkey.toBase58(),
          authority: ix.keys[2].pubkey.toBase58(),
          note: "every lamport the account holds goes to the destination",
        });
      } else {
        entries.push({
          program,
          instruction: "burn",
          account: ix.keys[0].pubkey.toBase58(),
          mint: ix.keys[1].pubkey.toBase58(),
          authority: ix.keys[2].pubkey.toBase58(),
          note: "permanently destroys the whole token balance",
        });
      }
    }
    if (feeReady) {
      entries.push({
        program: "System Program",
        instruction: "transfer",
        from: publicKey.toBase58(),
        to: "the published fee address",
        lamports: feeAmountLamports([
          {
            pubkey: reviewing.pubkey,
            mint: reviewing.mint,
            lamports: gatePreview.lamportsBeforeAction,
            program: reviewing.program,
          },
        ]).toString(),
        note: "1% of the rent this close recovers",
      });
    }
    return entries;
  }, [reviewing, publicKey, gatePreview, feeReady]);

  if (dust.length === 0) {
    return null;
  }

  const busy = actionInFlight;
  const otherActionInFlight =
    repairInFlight ||
    revokeInFlight ||
    unwrapInFlight ||
    excessInFlight === true;

  return (
    <div
      data-testid="burn-dust-section"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
    >
      <p className="text-sm text-zinc-300">Dust tokens</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        {dust.length} {plural(dust.length, "account", "accounts")}{" "}
        {plural(dust.length, "holds", "hold")} tokens. Burning a token
        destroys it permanently, and SOL.REPAIR cannot judge what a
        token is worth or whether it is still wanted. That judgment is
        yours. Burning the balance and closing the account returns
        everything the account holds to your wallet.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        Balances are from the scan (finalized view); the review card
        re-reads the account before you sign. Frozen accounts cannot be
        burned. A frozen account that still holds tokens stays skipped.
      </p>

      <div className="mt-3 space-y-2">
        {dust.map((c) => (
          <div
            key={c.pubkey}
            className="rounded-md border border-zinc-800 bg-black/40 p-2"
          >
            <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] leading-relaxed text-zinc-400">
              <span className="min-w-0 break-all">
                <AccountLink address={c.pubkey} />
                {" · mint "}
                <AccountLink address={c.mint} />
                <br />
                balance {groupDigits(c.amountAtScan)} base units (
                {c.decimals} decimals, at scan time) · account holds{" "}
                {groupCount(c.lamports)} lamports total ·{" "}
                {c.program === "token-2022"
                  ? "Token-2022"
                  : "SPL Token Program"}
              </span>
              <button
                onClick={() => beginReview(c)}
                disabled={otherActionInFlight || busy}
                className="shrink-0 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Burn and close
              </button>
            </div>
            <details className="mt-1">
              <summary className="cursor-pointer py-1 text-[11px] text-zinc-400 transition-colors hover:text-zinc-300">
                What burning this account means
              </summary>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                Burning permanently destroys the token balance. It is
                not undoable by this tool or any tool. SOL.REPAIR cannot
                tell whether a token is a scam, has value, or is still
                expected by a program; only you can decide. Closing the
                account afterwards deletes the account and returns every
                lamport it holds to your wallet. A standing delegation
                on the account ends when the account closes. SOL.REPAIR
                performs no transfer of its own beyond the disclosed 1%
                service fee. A future airdrop can open a new account at
                any time.
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
          {gatePreview.state === "already-gone" && (
            <>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                {ALREADY_GONE_COPY}
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
          {gatePreview.state === "already-empty" && (
            <>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                {ALREADY_EMPTY_COPY}
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
                You are about to approve 1 transaction that burns{" "}
                {groupDigits(gatePreview.balanceBeforeAction)} base units
                of mint {short(reviewing.mint)} and then closes token
                account {short(reviewing.pubkey)}. The burn is permanent.
                Everything the account holds goes to your wallet (
                {publicKey ? short(publicKey.toBase58()) : ""}). The
                account will no longer exist.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Balance at scan: {groupDigits(reviewing.amountAtScan)}{" "}
                base units. At the fresh read just now:{" "}
                {groupDigits(gatePreview.balanceBeforeAction)} base
                units. Total lamports at scan:{" "}
                {groupCount(reviewing.lamports)}. At the fresh read just
                now: {groupCount(gatePreview.lamportsBeforeAction)}.
              </p>
              {(gatePreview.balanceBeforeAction !==
                reviewing.amountAtScan ||
                gatePreview.lamportsBeforeAction !==
                  reviewing.lamports) && (
                <p className="mt-1 text-xs leading-relaxed text-amber-400/90">
                  The account changed between the scan and this read.
                  You would be burning the balance as it stands now.
                  SOL.REPAIR cannot tell what caused the change.
                </p>
              )}
              {gatePreview.delegate && (
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                  A delegate ({short(gatePreview.delegate)}) holds a
                  spending permission on this account. It does not block
                  your burn, and the delegation ends when the account
                  closes.
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                This transaction contains exactly two token-program
                instructions: a burn (permanently destroys the whole
                token balance), then closeAccount, from{" "}
                {reviewing.program === "token-2022"
                  ? "the Token-2022 program"
                  : "the SPL Token Program"}
                , with your wallet as the destination and the authority.
                {feeReady
                  ? " It also contains one transfer for the 1% service fee to the published fee address."
                  : " No fee transfer."}{" "}
                The burn sends tokens to no address; they are destroyed.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Network fee: ~{lamportsToSol(estimateNetworkFee())} SOL,
                paid from your wallet.
                {feeReady
                  ? ` Service fee: ~${lamportsToSol(
                      feeAmountLamports([
                        {
                          pubkey: reviewing.pubkey,
                          mint: reviewing.mint,
                          lamports: gatePreview.lamportsBeforeAction,
                          program: reviewing.program,
                        },
                      ])
                    )} SOL, 1% of the rent this close recovers.`
                  : " Service fee: none on this action (the fee account is not ready yet)."}{" "}
                Your wallet may add its own priority fee.
              </p>
              <details className="mt-2 rounded-md border border-zinc-800 p-2">
                <summary className="cursor-pointer py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                  Inspect exactly what you&rsquo;ll sign
                </summary>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
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
                  className="rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
                >
                  {sim.state === "running"
                    ? "Simulating on-chain..."
                    : "Run pre-sign simulation"}
                </button>
                {sim.state === "ok" && (
                  <p className="mt-1 text-xs leading-relaxed text-emerald-400">
                    Simulation passed. Expected effect: the token balance
                    is destroyed permanently and the account is deleted,
                    with everything it holds going to your wallet.
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
                    void burn(reviewing, feeReady);
                  }}
                  className="flex-1 rounded-lg bg-[#14F195] px-4 py-2.5 font-medium text-black transition-colors hover:bg-[#0fd584]"
                >
                  Approve &amp; Burn
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
              <BurnSpinner amber={AMBER_STATUSES.has(status)} />
              <p className="min-w-0 flex-1 text-sm text-zinc-300">
                {status === "checking-current-state" &&
                  "Checking the account's current state..."}
                {status === "building" && "Building transaction..."}
                {status === "awaiting-signature" &&
                  "Check your wallet. Approve to burn and close."}
                {status === "sending" &&
                  "Approved. Sending to the network..."}
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
          {outcome === "burn-verified" && (
            <>
              <p className="text-sm font-medium text-emerald-400">
                Burn and close complete.
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Token account{" "}
                {accountPubkey ? short(accountPubkey) : ""} no longer
                exists, confirmed by a fresh read after the transaction.
                Its balance of{" "}
                {balanceBeforeAction === null
                  ? "figure unavailable"
                  : `${groupDigits(balanceBeforeAction)} base units`}
                , read just before the burn, was destroyed permanently.
                Everything the account held went to your wallet as the
                close&rsquo;s destination.
              </p>
            </>
          )}
          {outcome === "already-gone" && (
            <p className="text-sm leading-relaxed text-zinc-300">
              {error}
            </p>
          )}
          {outcome === "already-empty" && (
            <p className="text-sm leading-relaxed text-zinc-300">
              {error}
            </p>
          )}
          {outcome === "close-unattributed" && (
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
          <p className="font-medium">The burn did not go through</p>
          <p className="mt-1 leading-relaxed text-red-400">{error}</p>
          {outcome === "on-chain-failure" &&
            accountPresentAfterAction === true && (
              <p className="mt-1 text-xs leading-relaxed text-red-400">
                When we checked, the account still existed.
              </p>
            )}
          {outcome === "on-chain-failure" &&
            accountPresentAfterAction === false && (
              <p className="mt-1 text-xs leading-relaxed text-red-400">
                A fresh read after it shows the account gone. Whether
                this app&rsquo;s transaction caused that could not be
                established.
              </p>
            )}
          {outcome === "on-chain-failure" &&
            accountPresentAfterAction === null && (
              <p className="mt-1 text-xs leading-relaxed text-red-400">
                The follow-up read failed, so the current state of the
                account is unknown.
              </p>
            )}
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

      {/* Unverified card (distinct from success and failure) */}
      {status === "unverified" && (
        <div className="mt-3 rounded-md border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-300">
          <p className="font-medium">
            We could not verify whether the burn landed
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
