"use client";

/**
 * NftBurnSection: presentation and per-item consent for the dead-NFT
 * burn-and-close action (docs/dead-nft-scope-memo-2026-11.md, the v1
 * slice; one hand-built Metaplex BurnNft per approved NFT).
 *
 * Renders only when the scan contains decimals-0 candidates the
 * detection classifies. The component owns the detection reads (the
 * memo's 2-3 batched calls piggybacking the scan), the honest rows for
 * the classes v1 does not offer (frozen, has-prints, metadata-only,
 * print edition, MasterEditionV1, Token-2022), and the confirmation
 * card for the burnable class; the authoritative gate, signing,
 * submission, resolution, and verification live in useNftBurn. The
 * pre-card read here is presentation only - the hook re-runs the gate
 * as its authoritative first step, in-lock.
 *
 * Routing contract (memo section 3.2): the burnable class's token
 * accounts are reported upward (onRoutedNftsChange) so the dust
 * section and the repair-everything pass hold them back; while
 * detection is in flight every candidate pubkey is reported as
 * pending, so a decimals-0 account can never be burned through the
 * plain dust flow before its NFT classification has landed - the
 * stranding hazard this feature exists to close. Nothing is selected
 * by default, one NFT per transaction, no images on any row: name,
 * collection, and mint are text read from the metadata accounts
 * through the same RPC provider, and self-declared, never a verified
 * identity.
 *
 * Copy rules (test-enforced, mirroring G.2/G.3): findings, never
 * verdicts; burning is permanent; SOL.REPAIR never judges what an NFT
 * is worth; no success wording while pending or unverified; no
 * em-dashes, no emojis, no exclamation marks, curly apostrophes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useRpcConnection } from "@/hooks/useRpcConnection";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { AwaitingSignatureHint } from "@/components/AwaitingSignatureHint";

import { useNftBurn } from "@/hooks/useNftBurn";
import {
  BURN_NFT_GATE_ABORT_COPY,
  buildBurnNftInstruction,
  detectNftCandidates,
  evaluateNftGate,
  findMasterEditionPda,
  findMetadataPda,
  nftBurnCardFeeLine,
  nftBurnCardFeeLineFeeEra,
  nftBurnCardIntro,
  nftBurnCardIntroFeeEra,
  NFT_ALREADY_GONE_COPY,
  NFT_BURN_CARD_COLLECTION,
  NFT_BURN_CARD_PERMANENCE,
  NFT_BURN_CARD_STRANDING,
  NFT_FROZEN_ROW_COPY,
  NFT_HAS_PRINTS_ROW_COPY,
  NFT_MASTER_V1_ROW_COPY,
  NFT_METADATA_ONLY_COPY,
  NFT_PRINT_EDITION_ROW_COPY,
  NFT_TOKEN22_ROW_COPY,
  nftRowSummary,
  readNftGateState,
  selectNftScanCandidates,
  type DetectedNft,
  type NftClass,
  type NftGateRead,
  type NftScanCandidate,
} from "@/lib/solana/nftBurn";
import { buildTransaction, estimateNetworkFee } from "@/lib/solana/transactions";
import { buildFeeTransfer, feeAmountLamports } from "@/lib/solana/fees";
import { SOLANA_NETWORK } from "@/lib/solana/connection";
import { lamportsToSol, type ScanResult } from "@/lib/solana/tokenAccounts";

function groupCount(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
 *  aria-hidden: it sits inside the role="status" card. */
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

function NftSpinner({ amber = false }: { amber?: boolean }) {
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
  | { state: "reading"; pubkey: string }
  | {
      state: "pass";
      /** The three pre-balances: the fee base (the ruling) and the
       *  drift check's figure. */
      rentLamports: number;
      tokenLamports: number;
      metadataLamports: number;
      /** What the metadata close actually returns (today's rent-exempt
       *  minimum, capped at the balance). Differs from
       *  metadataLamports only when a stored Metaplex create fee sits
       *  on the metadata. */
      metadataReturnLamports: number;
      editionLamports: number;
      collectionVerified: boolean;
      collectionKey: string | null;
      name: string | null;
    }
  | { state: "already-gone" }
  | { state: "metadata-only" }
  | { state: "abort"; sentence: string };

const NO_SIM = { state: "idle" } as const;

/** The honest sentence for each class the section does not offer. */
const CLASS_ROW_COPY: Partial<Record<NftClass, string>> = {
  frozen: NFT_FROZEN_ROW_COPY,
  "has-prints": NFT_HAS_PRINTS_ROW_COPY,
  "metadata-only": NFT_METADATA_ONLY_COPY,
  "print-edition": NFT_PRINT_EDITION_ROW_COPY,
  "master-v1": NFT_MASTER_V1_ROW_COPY,
  token22: NFT_TOKEN22_ROW_COPY,
};

const CLASS_ROW_LABEL: Partial<Record<NftClass, string>> = {
  frozen: "NFT (frozen)",
  "has-prints": "NFT (print editions outstanding)",
  "metadata-only": "NFT (metadata only)",
  "print-edition": "NFT (print edition)",
  "master-v1": "NFT (MasterEditionV1)",
  token22: "NFT (Token-2022)",
};

export function NftBurnSection({
  scan,
  rescan,
  repairInFlight,
  revokeInFlight,
  unwrapInFlight,
  burnInFlight,
  excessInFlight,
  feeReady,
  onActionInFlightChange,
  onRoutingChange,
}: {
  scan: ScanResult;
  rescan: () => void;
  repairInFlight: boolean;
  revokeInFlight: boolean;
  unwrapInFlight: boolean;
  burnInFlight: boolean;
  excessInFlight?: boolean;
  feeReady: boolean;
  onActionInFlightChange?: (inFlight: boolean) => void;
  /** The routing contract: while detection is in flight every
   *  decimals-0 candidate is pending (the dust flow and the pass hold
   *  it back); once classified, the burnable class's token accounts
   *  are routed here and the rest return to today's flow. */
  onRoutingChange?: (routing: { routed: ReadonlySet<string>; pending: ReadonlySet<string> }) => void;
}) {
  const connection = useRpcConnection();
  const { publicKey } = useWallet();
  const {
    status,
    outcome,
    signatures,
    accountPubkey,
    mint,
    tokenLamportsBeforeAction,
    accountsPresentAfterAction,
    note,
    error,
    errorDetail,
    actionInFlight,
    burn,
    reset,
  } = useNftBurn();

  const candidates = useMemo(
    () => selectNftScanCandidates(scan),
    [scan]
  );

  // Detection carries an explicit state (the ExcessSection pattern): a
  // failed detection must never be indistinguishable from a scan that
  // found nothing.
  type DetectionState =
    | { candidates: NftScanCandidate[]; status: "reading" }
    | { candidates: NftScanCandidate[]; status: "failed" }
    | { candidates: NftScanCandidate[]; status: "done"; detected: DetectedNft[] };
  const [detected, setDetected] = useState<DetectionState | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (candidates.length === 0) {
      setDetected({ candidates, status: "done", detected: [] });
      return;
    }
    let cancelled = false;
    setDetected({ candidates, status: "reading" });
    detectNftCandidates(connection, candidates)
      .then((found) => {
        if (!cancelled) {
          setDetected({ candidates, status: "done", detected: found });
        }
      })
      .catch(() => {
        if (!cancelled) setDetected({ candidates, status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [connection, candidates, retryNonce]);

  // The routing contract upward: pending covers every candidate while
  // the classification is unread (detection reading or failed); the
  // burnable class is routed out of the dust flow once classified.
  const detectionCurrent = detected !== null && detected.candidates === candidates;
  useEffect(() => {
    if (!detectionCurrent || detected === null) {
      onRoutingChange?.({
        routed: new Set(),
        pending: new Set(candidates.map((c) => c.pubkey)),
      });
      return;
    }
    if (detected.status !== "done") {
      onRoutingChange?.({
        routed: new Set(),
        pending: new Set(candidates.map((c) => c.pubkey)),
      });
      return;
    }
    onRoutingChange?.({
      routed: new Set(
        detected.detected
          .filter((d) => d.class === "burnable")
          .map((d) => d.candidate.pubkey)
      ),
      pending: new Set(),
    });
  }, [detectionCurrent, detected, candidates, onRoutingChange]);

  // Report the in-flight signal upward (the affordance half; the
  // mutex is the guarantee).
  useEffect(() => {
    onActionInFlightChange?.(actionInFlight);
  }, [actionInFlight, onActionInFlightChange]);

  const [reviewing, setReviewing] = useState<DetectedNft | null>(null);
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
    (d: DetectedNft) => {
      setReviewing(d);
      setGatePreview({ state: "reading", pubkey: d.candidate.pubkey });
      setSim(NO_SIM);
      // Presentation-only pre-card read; the hook re-runs the gate as
      // its authoritative in-lock first step.
      readNftGateState(connection, d.candidate)
        .then((read: NftGateRead) => {
          setGatePreview((prev) => {
            if (
              prev.state !== "reading" ||
              prev.pubkey !== d.candidate.pubkey ||
              !publicKey
            ) {
              return prev;
            }
            const verdict = evaluateNftGate(
              read,
              d.candidate.mint,
              publicKey.toBase58()
            );
            if (verdict.kind === "pass") {
              return {
                state: "pass",
                rentLamports:
                  verdict.tokenLamports +
                  verdict.metadataLamports +
                  verdict.editionLamports,
                tokenLamports: verdict.tokenLamports,
                metadataLamports: verdict.metadataLamports,
                metadataReturnLamports: verdict.metadataReturnLamports,
                editionLamports: verdict.editionLamports,
                collectionVerified: verdict.collectionVerified,
                collectionKey: verdict.collectionKey,
                name: verdict.name,
              };
            }
            if (verdict.kind === "already-gone") {
              return { state: "already-gone" };
            }
            if (verdict.kind === "metadata-only") {
              return { state: "metadata-only" };
            }
            return {
              state: "abort",
              sentence: BURN_NFT_GATE_ABORT_COPY[verdict.reason],
            };
          });
        })
        .catch(() => {
          setGatePreview((prev) =>
            prev.state === "reading" && prev.pubkey === d.candidate.pubkey
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
      const instructions = [
        buildBurnNftInstruction(
          {
            mint: reviewing.candidate.mint,
            tokenPubkey: reviewing.candidate.pubkey,
            collectionKey: gatePreview.collectionVerified
              ? gatePreview.collectionKey
              : null,
          },
          publicKey
        ),
      ];
      if (feeReady) {
        const mintKey = new PublicKey(reviewing.candidate.mint);
        const fee = buildFeeTransfer(publicKey, [
          {
            pubkey: reviewing.candidate.pubkey,
            mint: reviewing.candidate.mint,
            lamports: gatePreview.tokenLamports,
            program: "spl",
          },
          {
            pubkey: findMetadataPda(mintKey).toBase58(),
            mint: reviewing.candidate.mint,
            lamports: gatePreview.metadataLamports,
            program: "spl",
          },
          {
            pubkey: findMasterEditionPda(mintKey).toBase58(),
            mint: reviewing.candidate.mint,
            lamports: gatePreview.editionLamports,
            program: "spl",
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
    const burnIx = buildBurnNftInstruction(
      {
        mint: reviewing.candidate.mint,
        tokenPubkey: reviewing.candidate.pubkey,
        collectionKey: gatePreview.collectionVerified
          ? gatePreview.collectionKey
          : null,
      },
      publicKey
    );
    const keys = burnIx.keys.map((k) => k.pubkey.toBase58());
    const entry: Record<string, string> = {
      program: "Metaplex Token Metadata Program",
      instruction: "burnNft",
      metadata: keys[0],
      owner: keys[1],
      mint: keys[2],
      tokenAccount: keys[3],
      masterEdition: keys[4],
      splTokenProgram: keys[5],
      note: "burns the single token, then closes the token, metadata, and master edition accounts",
    };
    if (keys.length > 6) entry.collectionMetadata = keys[6];
    entries.push(entry);
    if (feeReady) {
      const mintKey = new PublicKey(reviewing.candidate.mint);
      entries.push({
        program: "System Program",
        instruction: "transfer",
        from: publicKey.toBase58(),
        to: "the published fee address",
        lamports: feeAmountLamports([
          {
            pubkey: reviewing.candidate.pubkey,
            mint: reviewing.candidate.mint,
            lamports: gatePreview.tokenLamports,
            program: "spl",
          },
          {
            pubkey: findMetadataPda(mintKey).toBase58(),
            mint: reviewing.candidate.mint,
            lamports: gatePreview.metadataLamports,
            program: "spl",
          },
          {
            pubkey: findMasterEditionPda(mintKey).toBase58(),
            mint: reviewing.candidate.mint,
            lamports: gatePreview.editionLamports,
            program: "spl",
          },
        ]).toString(),
        note: "1% of the SOL these three closes return",
      });
    }
    return entries;
  }, [reviewing, publicKey, gatePreview, feeReady]);

  // --- Rendering gate ---
  if (candidates.length === 0) {
    return null;
  }
  if (detectionCurrent && detected !== null && detected.status === "failed") {
    // A failed check renders its own honest state, never
    // absence-of-section: a user cannot tell "no NFTs" from "the check
    // never ran" if the section silently disappears.
    return (
      <div
        data-testid="nft-burn-section"
        className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
      >
        <p className="text-sm text-zinc-300">NFT burn-and-close</p>
        <p className="mt-1 text-xs leading-relaxed text-amber-400/90">
          The NFT check could not be read from the network. Nothing was
          checked this round, so a dead NFT may be missing from this
          list. Its accounts are held back from the dust flow until the
          check can run.
        </p>
        <button
          onClick={() => setRetryNonce((n) => n + 1)}
          className="mt-3 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
        >
          Scan again
        </button>
      </div>
    );
  }
  const detectedList =
    detectionCurrent && detected !== null && detected.status === "done"
      ? detected.detected
      : null;
  const burnable =
    detectedList !== null
      ? detectedList.filter((d) => d.class === "burnable")
      : [];
  const otherRows =
    detectedList !== null
      ? detectedList.filter((d) => CLASS_ROW_COPY[d.class] !== undefined)
      : [];
  if (detectedList === null) {
    // Detection still reading: a small honest reading state, so the
    // held-back candidates are never invisible.
    return (
      <div
        data-testid="nft-burn-section"
        className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
      >
        <p className="text-sm text-zinc-300">NFT burn-and-close</p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          Reading {candidates.length}{" "}
          {candidates.length === 1 ? "account" : "accounts"} for dead
          NFTs...
        </p>
      </div>
    );
  }
  if (burnable.length === 0 && otherRows.length === 0) {
    return null;
  }

  const busy = actionInFlight;
  const otherActionInFlight =
    repairInFlight ||
    revokeInFlight ||
    unwrapInFlight ||
    burnInFlight ||
    excessInFlight === true;

  const renderName = (d: DetectedNft) =>
    d.name ? (
      <>
        <span className="text-zinc-500">Name </span>
        {d.name} <span className="text-zinc-500">(self-declared)</span>
      </>
    ) : null;
  const renderCollection = (d: DetectedNft) =>
    d.collectionVerified ? (
      <>
        <br />
        <span className="text-zinc-500">Collection </span>
        {d.collectionName ?? "verified, name unreadable"}{" "}
        <span className="text-zinc-500">(mint </span>
        <AccountLink address={d.collectionKey ?? ""} />
        <span className="text-zinc-500">)</span>
      </>
    ) : null;

  return (
    <div
      data-testid="nft-burn-section"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
    >
      <p className="text-sm text-zinc-300">NFT burn-and-close</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        {burnable.length > 0 && (
          <>
            {burnable.length} dead{" "}
            {burnable.length === 1 ? "NFT" : "NFTs"}{" "}
            {burnable.length === 1 ? "is" : "are"} offered here. One
            instruction (Metaplex BurnNft) burns the NFT and closes its
            token, metadata, and master edition accounts, returning all
            three deposits to your wallet.
          </>
        )}
        {burnable.length > 0 && otherRows.length > 0 && " "}
        {otherRows.length > 0 && (
          <>
            {otherRows.length} further{" "}
            {otherRows.length === 1 ? "NFT" : "NFTs"}{" "}
            {otherRows.length === 1 ? "is" : "are"} listed below with an
            honest note and no offer: this version burns only classic
            master-edition-backed NFTs whose master edition has no prints
            outstanding.
          </>
        )}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        Burning is permanent and SOL.REPAIR cannot judge what an NFT is
        worth or whether it is still wanted. That judgment is yours.
        Names and collection names below are read from the metadata
        accounts through the same RPC provider and are self-declared,
        never a verified identity.
      </p>

      <div className="mt-3 space-y-2">
        {burnable.map((d) => {
          const rentSol = lamportsToSol(BigInt(d.rentLamports));
          const feeLamports = BigInt(d.rentLamports) / 100n;
          const feeSol = lamportsToSol(feeLamports);
          return (
            <div
              key={d.candidate.pubkey}
              className="rounded-md border border-zinc-800/60 bg-black/20 p-2"
            >
              <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] leading-relaxed text-zinc-400">
                <span className="min-w-0 break-all">
                  <span className="text-zinc-300">NFT burn-and-close </span>
                  <br />
                  <span className="text-zinc-500">Token account </span>
                  <AccountLink address={d.candidate.pubkey} />
                  <br />
                  <span className="text-zinc-500">Mint </span>
                  <AccountLink address={d.candidate.mint} />
                  {renderName(d) && (
                    <>
                      <br />
                      {renderName(d)}
                    </>
                  )}
                  {renderCollection(d)}
                  <br />
                  {nftRowSummary(rentSol, feeSol)}
                </span>
                <button
                  onClick={() => beginReview(d)}
                  disabled={otherActionInFlight || busy}
                  className="shrink-0 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Burn and close
                </button>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer py-1 text-[11px] text-zinc-400 transition-colors hover:text-zinc-300">
                  What burning this NFT means
                </summary>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                  {NFT_BURN_CARD_PERMANENCE} {NFT_BURN_CARD_STRANDING}{" "}
                  SOL.REPAIR performs no transfer of its own beyond the
                  disclosed 1% service fee. The NFT cannot be restored
                  once burned.
                </p>
              </details>
            </div>
          );
        })}
        {otherRows.map((d) => (
          <div
            key={d.candidate.pubkey}
            className="rounded-md border border-zinc-800/60 bg-black/20 p-2"
          >
            <div className="font-mono text-[11px] leading-relaxed text-zinc-400">
              <span className="min-w-0 break-all">
                <span className="text-zinc-300">
                  {CLASS_ROW_LABEL[d.class]}{" "}
                </span>
                <br />
                <span className="text-zinc-500">Token account </span>
                <AccountLink address={d.candidate.pubkey} />
                <br />
                <span className="text-zinc-500">Mint </span>
                <AccountLink address={d.candidate.mint} />
                {renderName(d) && (
                  <>
                    <br />
                    {renderName(d)}
                  </>
                )}
                {renderCollection(d)}
              </span>
              <p className="mt-1 leading-relaxed text-amber-500/70">
                {CLASS_ROW_COPY[d.class]}
              </p>
            </div>
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
            Burn NFT and close its accounts
          </p>
          {gatePreview.state === "reading" && (
            <p className="mt-2 text-xs text-zinc-400">
              Reading the accounts&rsquo; current state...
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
                {NFT_ALREADY_GONE_COPY}
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
          {gatePreview.state === "metadata-only" && (
            <>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                {NFT_METADATA_ONLY_COPY}
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
              {(() => {
                const depositSol = lamportsToSol(BigInt(gatePreview.rentLamports));
                const returnLamports =
                  gatePreview.tokenLamports +
                  gatePreview.metadataReturnLamports +
                  gatePreview.editionLamports;
                const feeLamports = BigInt(gatePreview.rentLamports) / 100n;
                if (returnLamports === gatePreview.rentLamports) {
                  return (
                    <>
                      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                        {nftBurnCardIntro(depositSol)}
                      </p>
                      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                        {nftBurnCardFeeLine(
                          feeLamports.toString(),
                          gatePreview.rentLamports.toString()
                        )}
                      </p>
                    </>
                  );
                }
                return (
                  <>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                      {nftBurnCardIntroFeeEra(
                        lamportsToSol(BigInt(returnLamports)),
                        depositSol
                      )}
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                      {nftBurnCardFeeLineFeeEra(
                        feeLamports.toString(),
                        gatePreview.rentLamports.toString()
                      )}
                    </p>
                  </>
                );
              })()}
              {gatePreview.collectionVerified && (
                <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                  {NFT_BURN_CARD_COLLECTION}
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                {NFT_BURN_CARD_PERMANENCE}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                {NFT_BURN_CARD_STRANDING}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Rents at the fresh read just now: token{" "}
                {groupCount(gatePreview.tokenLamports)}, metadata{" "}
                {groupCount(gatePreview.metadataLamports)}, master
                edition {groupCount(gatePreview.editionLamports)}{" "}
                lamports. Rent at scan:{" "}
                {groupCount(reviewing.rentLamports)} lamports.
              </p>
              {gatePreview.rentLamports !== reviewing.rentLamports && (
                <p className="mt-1 text-xs leading-relaxed text-amber-400/90">
                  The accounts changed between the scan and this read.
                  You would be burning what stands now. SOL.REPAIR
                  cannot tell what caused the change.
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                This transaction contains exactly one Metaplex BurnNft
                instruction
                {gatePreview.collectionVerified
                  ? " plus the verified collection's metadata account"
                  : ""}
                {feeReady
                  ? ", and one transfer for the 1% service fee to the published fee address"
                  : ""}
                {feeReady ? "." : ". No fee transfer."} The burn sends
                tokens to no address; the token is destroyed.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                Network fee: ~{lamportsToSol(estimateNetworkFee())} SOL,
                paid from your wallet. Your wallet may add its own
                priority fee.
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
                    Simulation passed. Expected effect: the token is
                    destroyed permanently and the token, metadata, and
                    master edition accounts are deleted, with all three
                    deposits going to your wallet.
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
                    void burn(reviewing.candidate, feeReady, {
                      rentLamports: gatePreview.rentLamports,
                    });
                  }}
                  className="flex-1 rounded-lg bg-[#14F195] px-4 py-2.5 font-medium text-black transition-colors hover:bg-[#0fd584]"
                >
                  Approve &amp; Burn NFT
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
              <NftSpinner amber={AMBER_STATUSES.has(status)} />
              <p className="min-w-0 flex-1 text-sm text-zinc-300">
                {status === "checking-current-state" &&
                  "Checking the accounts' current state..."}
                {status === "building" && "Building transaction..."}
                {status === "awaiting-signature" &&
                  "Check your wallet. Approve to burn the NFT and close its accounts."}
                {status === "sending" &&
                  "Approved. Sending to the network..."}
                {status === "confirming" &&
                  "Sent. Waiting for the network to confirm..."}
                {status === "verifying" &&
                  "Confirmed. Verifying the three accounts are gone on-chain..."}
              </p>
              {(status === "sending" ||
                status === "confirming" ||
                status === "verifying") && <ElapsedSeconds />}
            </div>
            {status === "awaiting-signature" && <AwaitingSignatureHint />}
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
          {outcome === "nft-burn-verified" && (
            <>
              <p className="text-sm font-medium text-emerald-400">
                Burn and close complete.
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Token account {accountPubkey ? short(accountPubkey) : ""}
                {mint ? ` (mint ${short(mint)})` : ""} no longer exists,
                and neither do its metadata and master edition accounts,
                confirmed by fresh reads after the transaction. All three
                deposits{" "}
                {tokenLamportsBeforeAction === null
                  ? "figure unavailable"
                  : `${groupCount(tokenLamportsBeforeAction)} lamports of rent the accounts held`}
                went to your wallet. The NFT was destroyed permanently.
              </p>
            </>
          )}
          {outcome === "already-gone" && (
            <p className="text-sm leading-relaxed text-zinc-300">
              {error}
            </p>
          )}
          {outcome === "metadata-only" && (
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
            accountsPresentAfterAction !== null && (
              <p className="mt-1 text-xs leading-relaxed text-red-400">
                When we checked: token account{" "}
                {accountsPresentAfterAction.token === true
                  ? "still exists"
                  : accountsPresentAfterAction.token === false
                    ? "is gone"
                    : "could not be read"}
                , metadata{" "}
                {accountsPresentAfterAction.metadata === true
                  ? "still exists"
                  : accountsPresentAfterAction.metadata === false
                    ? "is gone"
                    : "could not be read"}
                , master edition{" "}
                {accountsPresentAfterAction.edition === true
                  ? "still exists"
                  : accountsPresentAfterAction.edition === false
                    ? "is gone"
                    : "could not be read"}
                .
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
