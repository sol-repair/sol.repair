"use client";

/**
 * useNftBurn: the dead-NFT burn-and-close action hook (the v1 slice of
 * docs/dead-nft-scope-memo-2026-11.md, owner build word 2026-11-13).
 *
 * Mirrors useBurnDust structurally on purpose — the same evidence
 * lifecycle, the same one-re-sign budget, the same §8.5 corroboration
 * standard, the same §8.11 lock hold on the unresolved terminal — with
 * the NFT substitutions:
 *   - the action kind is "nft" in the cross-action mutex;
 *   - the gate is evaluateNftGate over ONE batched read of the token
 *     account, the metadata PDA, and the master edition PDA (the N1-N7
 *     abort rows; already-gone and metadata-only terminals);
 *   - the builder is the hand-built BurnNft (tag 29) from the gate's
 *     collection evidence, with the 1% fee riding AFTER it on the sum
 *     of the three pre-balances (the memo §1.3 ruling; the fee base is
 *     supplied to the existing buildFeeTransfer, fees.ts untouched);
 *   - verification reads all three accounts: a successful BurnNft
 *     closes them atomically, so all three gone is burn-verified, and
 *     any partial state is reported for exactly what it shows.
 *
 * This hook NEVER signs anything itself. It hands the unsigned
 * transaction to the wallet adapter for the user to approve.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { useRpcConnection } from "@/hooks/useRpcConnection";
import bs58 from "bs58";
import { PublicKey, type Transaction } from "@solana/web3.js";

import { acquireAction, heldAction, releaseAction } from "@/lib/actionMutex";
import { buildFeeTransfer } from "@/lib/solana/fees";
import { buildTransaction } from "@/lib/solana/transactions";
import {
  classifySignRefusal,
  corroborateNonLanding,
  RESOLVE_POLL_INTERVAL_MS,
  resolveTransaction,
  sleep,
  type CorroborationRead,
  type CorroborationVerdict,
} from "@/lib/solana/actionLifecycle";
import {
  BURN_NFT_GATE_ABORT_COPY,
  buildBurnNftInstruction,
  evaluateNftGate,
  findMasterEditionPda,
  findMetadataPda,
  NFT_ALREADY_GONE_COPY,
  NFT_METADATA_ONLY_COPY,
  readNftGateState,
  type NftGateRead,
  type NftGateVerdict,
  type NftScanCandidate,
} from "@/lib/solana/nftBurn";

export type NftBurnStatus =
  | "idle"
  | "checking-current-state"
  | "building"
  | "awaiting-signature"
  | "sending"
  | "confirming"
  | "verifying"
  | "done"
  | "error"
  | "unverified";

export type NftBurnOutcome =
  // done
  | "nft-burn-verified"
  | "already-gone"
  | "metadata-only"
  | "close-unattributed"
  // error
  | "gate-state-changed"
  | "cancelled"
  | "expired"
  | "on-chain-failure"
  | "action-conflict"
  | "recreated-after-close"
  | "partial-close-seen"
  | "state-changed-since-review"
  // unverified
  | "unresolved-outcome"
  | "confirmed-verification-unavailable";

/** Per-account presence after the action, one boolean each for the
 *  three accounts the burn closes (null = the read could not say). */
export interface NftPresenceAfterAction {
  token: boolean | null;
  metadata: boolean | null;
  edition: boolean | null;
}

export interface NftBurnState {
  status: NftBurnStatus;
  outcome: NftBurnOutcome | null;
  signatures: string[];
  accountPubkey: string | null;
  mint: string | null;
  rentAtScan: number | null;
  tokenLamportsBeforeAction: number | null;
  metadataLamportsBeforeAction: number | null;
  editionLamportsBeforeAction: number | null;
  accountsPresentAfterAction: NftPresenceAfterAction | null;
  note: string | null;
  error: string | null;
  errorDetail: string | null;
}

const INITIAL_STATE: NftBurnState = {
  status: "idle",
  outcome: null,
  signatures: [],
  accountPubkey: null,
  mint: null,
  rentAtScan: null,
  tokenLamportsBeforeAction: null,
  metadataLamportsBeforeAction: null,
  editionLamportsBeforeAction: null,
  accountsPresentAfterAction: null,
  note: null,
  error: null,
  errorDetail: null,
};

/** The corroboration snapshot: the gate's pre-send evidence the reads
 *  are judged against (the reviewed baseline). */
interface GateSnapshot {
  amount: string;
  tokenLamports: number;
  metadataLamports: number;
  editionLamports: number;
  mint: string;
}

type NftCorroboration =
  | {
      type: "state-changed-since-review";
      observedAmount: string;
      observedTokenLamports: number;
      observedRentLamports: number;
    };

class FriendlyError extends Error {
  outcome: NftBurnOutcome;
  constructor(message: string, outcome: NftBurnOutcome = "cancelled") {
    super(message);
    this.outcome = outcome;
  }
}

/** The in-flight statuses for the cross-action affordance. */
const IN_FLIGHT_STATUSES: ReadonlySet<NftBurnStatus> = new Set([
  "checking-current-state",
  "building",
  "awaiting-signature",
  "sending",
  "confirming",
  "verifying",
]);

export function useNftBurn() {
  const connection = useRpcConnection();
  const wallet = useWallet();

  const [state, setState] = useState<NftBurnState>(INITIAL_STATE);

  const burnInFlight = useRef(false);

  const livePublicKeyRef = useRef(wallet.publicKey);
  useEffect(() => {
    livePublicKeyRef.current = wallet.publicKey;
  }, [wallet.publicKey]);

  const statusRef = useRef<NftBurnStatus>("idle");
  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  // The unresolved-outcome hold is owned by THIS instance (the same
  // §8.11 contract useBurnDust runs): set when the action acquires the
  // mutex, cleared when that action's finally (or the dismissal reset)
  // releases it. The unmount cleanup refuses to release a hold this
  // instance did not acquire.
  const holdsLockRef = useRef(false);
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (
        holdsLockRef.current &&
        statusRef.current === "unverified" &&
        heldAction() === "nft"
      ) {
        releaseAction("nft");
        holdsLockRef.current = false;
      }
    };
  }, []);

  const burn = useCallback(
    async (
      candidate: NftScanCandidate,
      feeReady: boolean,
      reviewed?: { rentLamports?: number }
    ) => {
      if (burnInFlight.current) return;
      burnInFlight.current = true;

      let holdLockForDismissal = false;
      try {
        if (!wallet.publicKey || !wallet.signTransaction) {
          setState({
            ...INITIAL_STATE,
            status: "error",
            outcome: "cancelled",
            error: "Wallet not connected or does not support signing.",
          });
          return;
        }
        if (!acquireAction("nft")) {
          setState({
            ...INITIAL_STATE,
            status: "error",
            outcome: "action-conflict",
            error: "Another wallet action is underway. Wait for it to finish.",
          });
          return;
        }
        holdsLockRef.current = true;

        const actionOwner = wallet.publicKey;
        const signer = wallet.signTransaction;

        const setRunState = (
          patch:
            | Partial<NftBurnState>
            | ((prev: NftBurnState) => Partial<NftBurnState>)
        ) =>
          setState((prev) =>
            typeof patch === "function"
              ? { ...prev, ...patch(prev) }
              : { ...prev, ...patch }
          );

        setState({
          ...INITIAL_STATE,
          status: "checking-current-state",
          accountPubkey: candidate.pubkey,
          mint: candidate.mint,
          rentAtScan: candidate.lamports,
        });

        // ---- The refresh gate (authoritative, in-lock) ----
        // ONE batched read of the three accounts the instruction
        // closes, at the confirmation commitment.
        let gateRead: NftGateRead;
        try {
          gateRead = await readNftGateState(connection, candidate);
        } catch {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            error:
              "The current account state could not be read. Nothing was signed.",
          });
          return;
        }
        const verdict: NftGateVerdict = evaluateNftGate(
          gateRead,
          candidate.mint,
          actionOwner.toBase58()
        );
        if (verdict.kind === "abort") {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            error: BURN_NFT_GATE_ABORT_COPY[verdict.reason],
          });
          return;
        }
        if (verdict.kind === "already-gone") {
          setRunState({
            status: "done",
            outcome: "already-gone",
            accountsPresentAfterAction: { token: false, metadata: null, edition: null },
            error: NFT_ALREADY_GONE_COPY,
          });
          return;
        }
        if (verdict.kind === "metadata-only") {
          setRunState({
            status: "done",
            outcome: "metadata-only",
            accountsPresentAfterAction: { token: true, metadata: true, edition: false },
            error: NFT_METADATA_ONLY_COPY,
          });
          return;
        }
        // Gate passed. Consent is with the REVIEWED rent figure (the
        // revised Case B policy, shared with the dust flow): when the
        // in-lock gate read's three-account sum differs from the
        // reviewed figure, the flow stops before anything is built or
        // signed and requires a fresh review click. Callers that omit
        // the reviewed figure keep the drift-consent behavior.
        const rentBeforeAction =
          verdict.tokenLamports + verdict.metadataLamports + verdict.editionLamports;
        if (reviewed && reviewed.rentLamports !== undefined && reviewed.rentLamports !== rentBeforeAction) {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            error:
              "The accounts no longer match what you reviewed. The fresh read shows " +
              `${rentBeforeAction} lamports across the three accounts. Nothing was signed. ` +
              "Start a fresh review to approve the current figures.",
          });
          return;
        }
        setRunState({
          tokenLamportsBeforeAction: verdict.tokenLamports,
          metadataLamportsBeforeAction: verdict.metadataLamports,
          editionLamportsBeforeAction: verdict.editionLamports,
        });
        const snapshot: GateSnapshot = {
          amount: "1",
          tokenLamports: verdict.tokenLamports,
          metadataLamports: verdict.metadataLamports,
          editionLamports: verdict.editionLamports,
          mint: candidate.mint,
        };

        // ---- Sign-and-resolve loop, with the single re-sign budget ----
        let reSignUsed = false;
        let refusalRetryUsed = false;
        let lastResolutionNote: string | null = null;

        // The §8.5 corroboration read: the same batched triple read the
        // gate uses, reduced to the shared shapes. A token account that
        // is no longer a readable token account reads as missing (the
        // honest account-gone terminal); any other unreadable figure is
        // unusable.
        const readOnce = async (): Promise<
          CorroborationRead<{
            token: Extract<NftGateRead["token"], { kind: "read" }>;
            metadataLamports: number;
            editionLamports: number;
          }>
        > => {
          try {
            const read = await readNftGateState(connection, candidate);
            if (read.token.kind === "read") {
              if (read.metadata.kind !== "read" || read.edition.kind !== "read") {
                return { kind: "unusable" };
              }
              return {
                kind: "read",
                value: {
                  token: read.token,
                  metadataLamports: read.metadata.lamports,
                  editionLamports: read.edition.lamports,
                },
              };
            }
            if (read.token.kind === "missing") return { kind: "missing" };
            return { kind: "unusable" };
          } catch {
            return { kind: "unusable" };
          }
        };
        // Every read is judged against the gate's pre-send snapshot:
        // the token figure AND the two closed accounts' deposits, so a
        // figure that moved since the review blocks the re-sign even
        // when the reads agree with each other. Token identity is
        // judged on every read (classic program, unfrozen, mint match),
        // and lamports continuity between reads is the second layer.
        const judge = (
          read: {
            token: Extract<NftGateRead["token"], { kind: "read" }>;
            metadataLamports: number;
            editionLamports: number;
          },
          prior: {
            token: Extract<NftGateRead["token"], { kind: "read" }>;
            metadataLamports: number;
            editionLamports: number;
          } | null
        ): CorroborationVerdict<NftCorroboration> | null => {
          if (
            read.token.amount !== snapshot.amount ||
            read.token.lamports !== snapshot.tokenLamports ||
            read.metadataLamports !== snapshot.metadataLamports ||
            read.editionLamports !== snapshot.editionLamports
          ) {
            return {
              type: "state-changed-since-review",
              observedAmount: read.token.amount,
              observedTokenLamports: read.token.lamports,
              observedRentLamports:
                read.token.lamports + read.metadataLamports + read.editionLamports,
            };
          }
          if (
            read.token.program !== "spl" ||
            read.token.frozen ||
            read.token.mint !== snapshot.mint
          ) {
            return {
              type: "cannot-establish",
              detail: "the account read could not confirm the token identity",
            };
          }
          if (
            prior &&
            (prior.token.lamports !== read.token.lamports ||
              prior.metadataLamports !== read.metadataLamports ||
              prior.editionLamports !== read.editionLamports)
          ) {
            return {
              type: "cannot-establish",
              detail:
                "the accounts' lamports changed between the two corroboration reads, so their continuity is not established",
            };
          }
          return null;
        };

        const build = async () => {
          const instructions = [
            buildBurnNftInstruction(
              {
                mint: candidate.mint,
                tokenPubkey: candidate.pubkey,
                collectionKey: verdict.collectionVerified
                  ? verdict.collectionKey
                  : null,
              },
              actionOwner
            ),
          ];
          // The 1% fee rides AFTER the burn, on the sum of the three
          // accounts' pre-balances (the memo §1.3 ruling). The fee base
          // is three entries to the existing buildFeeTransfer - fees.ts
          // stays byte-identical; the program field is display-only in
          // the fee math. The burned token itself is destroyed, not
          // recovered, and is charged nothing beyond its share of the
          // close base.
          if (feeReady) {
            const mintKey = new PublicKey(candidate.mint);
            const fee = buildFeeTransfer(actionOwner, [
              {
                pubkey: candidate.pubkey,
                mint: candidate.mint,
                lamports: verdict.tokenLamports,
                program: "spl",
              },
              {
                pubkey: findMetadataPda(mintKey).toBase58(),
                mint: candidate.mint,
                lamports: verdict.metadataLamports,
                program: "spl",
              },
              {
                pubkey: findMasterEditionPda(mintKey).toBase58(),
                mint: candidate.mint,
                lamports: verdict.editionLamports,
                program: "spl",
              },
            ]);
            if (fee) instructions.push(fee);
          }
          return buildTransaction(connection, actionOwner, instructions);
        };

        for (;;) {
          const liveBeforeBuild = livePublicKeyRef.current;
          if (!liveBeforeBuild || !liveBeforeBuild.equals(actionOwner)) {
            throw new FriendlyError(
              "The connected wallet changed. Stopped before signing anything."
            );
          }

          setRunState({
            status: "building",
            note: lastResolutionNote,
          });
          const unsigned = await build();

          const liveBeforeSign = livePublicKeyRef.current;
          if (!liveBeforeSign || !liveBeforeSign.equals(actionOwner)) {
            throw new FriendlyError(
              "The connected wallet changed. Stopped before signing anything."
            );
          }

          setRunState({ status: "awaiting-signature" });
          let signed: Transaction;
          try {
            signed = await signer(unsigned);
          } catch (signError) {
            const refusal = classifySignRefusal(signError);
            if (refusal === "rejected") {
              throw new FriendlyError(
                "Transaction cancelled. Nothing was sent."
              );
            }
            if (refusal === "expired-refusal") {
              if (!refusalRetryUsed) {
                refusalRetryUsed = true;
                lastResolutionNote =
                  "The wallet refused the request: the transaction had expired. Nothing was signed. Retrying once with a fresh transaction.";
                continue;
              }
              throw new FriendlyError(
                "The wallet refused the request: the transaction had expired. Nothing was signed.",
                "expired"
              );
            }
            const message =
              signError instanceof Error
                ? signError.message
                : String(signError);
            const raw = new Error(message);
            raw.name = signError instanceof Error ? signError.name : "Error";
            throw raw;
          }

          const signatureBytes = signed.signatures[0]?.signature;
          if (!signatureBytes) {
            throw new FriendlyError(
              "Wallet returned a transaction without a signature. Nothing was sent."
            );
          }
          const signature = bs58.encode(signatureBytes);
          setRunState((prev) => ({
            status: "sending",
            signatures: [...prev.signatures, signature],
            note: null,
          }));

          const lastValidBlockHeight = unsigned.lastValidBlockHeight;
          let sendFailure: string | null = null;
          try {
            await connection.sendRawTransaction(signed.serialize());
          } catch (sendError) {
            sendFailure =
              sendError instanceof Error
                ? sendError.message
                : String(sendError);
          }

          setRunState({ status: "confirming" });
          const resolution = await resolveTransaction(
            connection,
            signature,
            lastValidBlockHeight,
            () =>
              corroborateNonLanding(
                connection,
                signature,
                lastValidBlockHeight,
                readOnce,
                judge
              ),
            setRunState
          );

          if (resolution.type === "confirmed") {
            // ---- Independent verification ----
            // A successful BurnNft closes all three accounts
            // atomically; the verification reads the triple and
            // reports exactly what it shows.
            setRunState({ status: "verifying" });
            await sleep(RESOLVE_POLL_INTERVAL_MS);
            const tryVerificationRead = async (): Promise<NftPresenceAfterAction> => {
              try {
                const read = await readNftGateState(connection, candidate);
                return {
                  token: read.token.kind === "missing" ? false : read.token.kind === "read" ? true : null,
                  metadata: read.metadata.kind === "missing" ? false : read.metadata.kind === "read" ? true : null,
                  edition: read.edition.kind === "missing" ? false : read.edition.kind === "read" ? true : null,
                };
              } catch {
                return { token: null, metadata: null, edition: null };
              }
            };
            const firstRead = await tryVerificationRead();
            if (
              firstRead.token === false &&
              firstRead.metadata === false &&
              firstRead.edition === false
            ) {
              setRunState({
                accountsPresentAfterAction: firstRead,
                status: "done",
                outcome: "nft-burn-verified",
              });
              return;
            }
            // One spaced corroborating read before any scary terminal.
            await sleep(RESOLVE_POLL_INTERVAL_MS);
            const secondRead = await tryVerificationRead();
            if (
              secondRead.token === false &&
              secondRead.metadata === false &&
              secondRead.edition === false
            ) {
              setRunState({
                accountsPresentAfterAction: secondRead,
                status: "done",
                outcome: "nft-burn-verified",
              });
              return;
            }
            const settled =
              secondRead.token === null &&
              secondRead.metadata === null &&
              secondRead.edition === null
                ? null
                : secondRead;
            if (settled !== null) {
              if (settled.token === false) {
                // The token is gone but a closed account still shows:
                // the atomic shape would be broken. Report exactly what
                // was seen; nothing more is sent automatically.
                setRunState({
                  accountsPresentAfterAction: settled,
                  status: "error",
                  outcome: "partial-close-seen",
                  error:
                    "The transaction was confirmed by the network, and a fresh read shows the token account gone" +
                    (settled.metadata === true
                      ? " but the metadata account still present"
                      : "") +
                    (settled.edition === true
                      ? `${settled.metadata === true ? " and" : " but"} the master edition account still present`
                      : "") +
                    ". This is not the shape a completed burn produces. SOL.REPAIR cannot tell what changed the remaining accounts. Nothing more will be sent automatically.",
                });
                return;
              }
              setRunState({
                accountsPresentAfterAction: settled,
                status: "error",
                outcome: "recreated-after-close",
                error:
                  "The transaction was confirmed by the network, but a fresh read shows an account at this NFT's addresses again. SOL.REPAIR cannot tell what created it. Nothing more will be sent automatically.",
              });
              return;
            }
            setRunState({
              accountsPresentAfterAction: null,
              status: "unverified",
              outcome: "confirmed-verification-unavailable",
              error:
                "The transaction was confirmed by the network, but the follow-up read failed, so the burn is unverified.",
            });
            return;
          }

          if (resolution.type === "on-chain-error") {
            let presenceAfter: NftPresenceAfterAction = {
              token: null,
              metadata: null,
              edition: null,
            };
            try {
              const read = await readNftGateState(connection, candidate);
              presenceAfter = {
                token: read.token.kind === "missing" ? false : read.token.kind === "read" ? true : null,
                metadata: read.metadata.kind === "missing" ? false : read.metadata.kind === "read" ? true : null,
                edition: read.edition.kind === "missing" ? false : read.edition.kind === "read" ? true : null,
              };
            } catch {
              // observation unavailable; stated as such
            }
            setRunState({
              status: "error",
              outcome: "on-chain-failure",
              accountsPresentAfterAction: presenceAfter,
              error:
                "The transaction was confirmed on-chain but failed. Nothing changed except the network fee, which was still charged. Nothing was burned.",
            });
            return;
          }

          if (resolution.type === "account-gone") {
            setRunState({
              status: "done",
              outcome: "close-unattributed",
              accountsPresentAfterAction: { token: false, metadata: null, edition: null },
              error:
                "The token account is gone. Whether this app's transaction closed it could not be established.",
            });
            return;
          }

          if (resolution.type === "domain") {
            // The corroboration reads left the reviewed baseline: the
            // window is provably closed, so nothing can land, and no
            // re-sign is attempted. The card reports the state as it
            // reads now and requires a fresh review.
            const changed = resolution.verdict;
            setRunState({
              status: "error",
              outcome: "state-changed-since-review",
              error:
                "The transaction expired without landing, and the accounts changed since you reviewed it. " +
                `When we checked, the token held ${changed.observedAmount} base units, the token account held ` +
                `${changed.observedTokenLamports} lamports, and the three accounts together held ` +
                `${changed.observedRentLamports}. Nothing more will be sent automatically. ` +
                "Start a fresh review to see the current state.",
            });
            return;
          }

          if (resolution.type === "unresolved") {
            holdLockForDismissal = true;
            setRunState({
              status: "unverified",
              outcome: "unresolved-outcome",
              errorDetail: sendFailure
                ? `${resolution.detail}; the submission itself failed with: ${sendFailure}`
                : resolution.detail,
              error:
                "We could not verify whether the burn landed. The transaction's outcome could not be established. It may still land. Nothing more will be sent automatically.",
            });
            return;
          }

          // expired-standard-met: provable non-landing, corroborated.
          if (reSignUsed) {
            let observation: NftPresenceAfterAction | null = null;
            try {
              const read = await readNftGateState(connection, candidate);
              observation = {
                token: read.token.kind === "missing" ? false : read.token.kind === "read" ? true : null,
                metadata: read.metadata.kind === "missing" ? false : read.metadata.kind === "read" ? true : null,
                edition: read.edition.kind === "missing" ? false : read.edition.kind === "read" ? true : null,
              };
            } catch {
              // observation unavailable; stated as such
            }
            if (
              observation !== null &&
              observation.token === false &&
              observation.metadata === false &&
              observation.edition === false
            ) {
              setRunState({
                status: "done",
                outcome: "close-unattributed",
                accountsPresentAfterAction: observation,
                error:
                  "The accounts are gone. Whether this app's transaction closed them could not be established.",
              });
              return;
            }
            setRunState({
              status: "error",
              outcome: "expired",
              accountsPresentAfterAction:
                observation === null
                  ? null
                  : {
                      token: observation.token,
                      metadata: observation.metadata,
                      edition: observation.edition,
                    },
              error:
                observation === null
                  ? "The transaction expired again and was not retried further. The follow-up read failed, so the current state of the accounts is unknown."
                  : "The transaction expired again and was not retried further. When we checked, the accounts still existed.",
            });
            return;
          }
          reSignUsed = true;
          lastResolutionNote =
            "The transaction expired before the network confirmed it. Nothing landed. Retrying once with a fresh transaction. Your approval is required again.";
          // loop: fresh build + fresh explicit approval
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const friendly = err instanceof FriendlyError;
        setState((prev) => ({
          ...prev,
          status: "error",
          outcome: friendly ? err.outcome : "cancelled",
          note: null,
          error: friendly
            ? message
            : "The burn could not be prepared. Nothing was signed or sent.",
          errorDetail: friendly ? null : message,
        }));
      } finally {
        // The unresolved hold survives only while the dismissal card is
        // mounted. Past an unmount no card can ever be shown, so the
        // hold releases there instead of orphaning the mutex against
        // the remounted page.
        if (!holdLockForDismissal || unmountedRef.current) {
          releaseAction("nft");
          holdsLockRef.current = false;
        }
        burnInFlight.current = false;
      }
    },
    [connection, wallet]
  );

  const reset = useCallback(() => {
    if (statusRef.current === "unverified" && heldAction() === "nft") {
      releaseAction("nft");
      holdsLockRef.current = false;
    }
    setState(INITIAL_STATE);
  }, []);

  const actionInFlight =
    IN_FLIGHT_STATUSES.has(state.status) ||
    // The unresolved terminal holds the mutex until the user
    // dismisses it (§8.11); the affordance must say so too, or the
    // page would re-enable buttons that can only end in an
    // action-conflict error.
    (state.status === "unverified" &&
      state.outcome === "unresolved-outcome");

  return { ...state, actionInFlight, burn, reset };
}
