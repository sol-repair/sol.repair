"use client";

/**
 * useWithdrawExcess: the G.4 excess-lamport action hook
 * (docs/g4-excess-lamports-spec-draft.md, Revision 1).
 *
 * Mirrors useBurnDust structurally: the same §8.5 evidence lifecycle,
 * the same one-re-sign budget, the same §8.11 lock hold on the
 * unresolved terminal, with the withdrawal substitutions:
 *   - the action kind is "excess" in the cross-action mutex;
 *   - the gate is evaluateExcessGate (excess gone -> already-withdrawn);
 *   - the builder is the single hand-built tag-38 instruction;
 *   - there is NO fee (the withdrawn lamports are the user's own
 *     principal and nothing closes);
 *   - verification reads lamports, not account existence: the account
 *     is EXPECTED to remain, holding exactly its reserve.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { useRpcConnection } from "@/hooks/useRpcConnection";
import bs58 from "bs58";
import type { Connection, Transaction } from "@solana/web3.js";

import { acquireAction, heldAction, releaseAction } from "@/lib/actionMutex";
import { buildTransaction } from "@/lib/solana/transactions";
import {
  buildWithdrawExcessInstruction,
  evaluateExcessGate,
  readExcessState,
  type ExcessCandidate,
  type ExcessRead,
} from "@/lib/solana/excessLamports";

export type ExcessStatus =
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

export type ExcessOutcome =
  // done
  | "withdraw-verified"
  | "already-withdrawn"
  | "already-gone"
  | "unattributed"
  // error
  | "gate-state-changed"
  | "cancelled"
  | "expired"
  | "on-chain-failure"
  | "action-conflict"
  // unverified
  | "unresolved-outcome"
  | "confirmed-verification-unavailable";

export interface ExcessState {
  status: ExcessStatus;
  outcome: ExcessOutcome | null;
  signatures: string[];
  accountPubkey: string | null;
  excessAtDetection: number | null;
  lamportsAtDetection: number | null;
  excessBeforeAction: number | null;
  lamportsBeforeAction: number | null;
  lamportsAfterAction: number | null;
  note: string | null;
  error: string | null;
  errorDetail: string | null;
}

const INITIAL_STATE: ExcessState = {
  status: "idle",
  outcome: null,
  signatures: [],
  accountPubkey: null,
  excessAtDetection: null,
  lamportsAtDetection: null,
  excessBeforeAction: null,
  lamportsBeforeAction: null,
  lamportsAfterAction: null,
  note: null,
  error: null,
  errorDetail: null,
};

class FriendlyError extends Error {
  outcome: ExcessOutcome;
  constructor(message: string, outcome: ExcessOutcome = "cancelled") {
    super(message);
    this.outcome = outcome;
  }
}

const RESOLVE_POLL_INTERVAL_MS = 1500;
const MAX_STATUS_RPC_ATTEMPTS = 3;
const MAX_FAILED_ROUNDS = 3;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type StatusOutcome =
  | { kind: "resolved"; err: unknown }
  | { kind: "unobserved" }
  | { kind: "rpc-failed" };

async function querySignatureStatus(
  connection: Connection,
  signature: string
): Promise<StatusOutcome> {
  for (let attempt = 1; attempt <= MAX_STATUS_RPC_ATTEMPTS; attempt++) {
    try {
      const statuses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: false,
      });
      const status = statuses.value[0];
      if (!status) return { kind: "unobserved" };
      return { kind: "resolved", err: status.err ?? null };
    } catch {
      if (attempt < MAX_STATUS_RPC_ATTEMPTS) {
        await sleep(RESOLVE_POLL_INTERVAL_MS);
      }
    }
  }
  return { kind: "rpc-failed" };
}

async function readBlockHeight(connection: Connection): Promise<number | null> {
  try {
    return await connection.getBlockHeight({ commitment: "confirmed" });
  } catch {
    return null;
  }
}

type Corroboration =
  | { type: "standard-met" }
  | { type: "resolved"; err: unknown }
  | { type: "account-gone" }
  | { type: "cannot-establish"; detail: string };

/**
 * The non-landing evidence standard, with the withdrawal substitution:
 * the account is EXPECTED to remain, so presence alone is not evidence
 * of non-landing — the lamports figure must be identical across the
 * two spaced reads (a landed withdrawal changes it).
 */
async function corroborateNonLanding(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  candidate: ExcessCandidate
): Promise<Corroboration> {
  const readOnce = async (): Promise<ExcessRead | { kind: "rpc-failed" }> => {
    try {
      return await readExcessState(connection, candidate.pubkey);
    } catch {
      return { kind: "rpc-failed" };
    }
  };

  const status1 = await querySignatureStatus(connection, signature);
  if (status1.kind === "resolved") {
    return { type: "resolved", err: status1.err };
  }
  if (status1.kind === "rpc-failed") {
    return {
      type: "cannot-establish",
      detail: "the signature status could not be read",
    };
  }

  const read1 = await readOnce();
  if (read1.kind === "rpc-failed") {
    return { type: "cannot-establish", detail: "the account read failed" };
  }
  if (read1.kind === "missing") {
    return { type: "account-gone" };
  }

  await sleep(RESOLVE_POLL_INTERVAL_MS);

  const status2 = await querySignatureStatus(connection, signature);
  if (status2.kind === "resolved") {
    return { type: "resolved", err: status2.err };
  }
  if (status2.kind === "rpc-failed") {
    return {
      type: "cannot-establish",
      detail: "the signature status could not be read",
    };
  }

  const height2 = await readBlockHeight(connection);
  if (height2 === null) {
    return {
      type: "cannot-establish",
      detail: "the block height could not be read",
    };
  }
  if (height2 <= lastValidBlockHeight) {
    return {
      type: "cannot-establish",
      detail: "the block height moved back inside the transaction window",
    };
  }

  const read2 = await readOnce();
  if (read2.kind === "rpc-failed") {
    return { type: "cannot-establish", detail: "the account read failed" };
  }
  if (read2.kind === "missing") {
    return { type: "account-gone" };
  }
  if (
    read2.lamports !== read1.lamports ||
    read2.excess !== read1.excess
  ) {
    return {
      type: "cannot-establish",
      detail:
        "the account's lamports changed between the two corroboration reads, so its continuity is not established",
    };
  }

  return { type: "standard-met" };
}

type Resolution =
  | { type: "confirmed" }
  | { type: "on-chain-error" }
  | { type: "expired-standard-met" }
  | { type: "account-gone" }
  | { type: "unresolved"; detail: string };

async function resolveTransaction(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  candidate: ExcessCandidate,
  setRunState: (patch: Partial<ExcessState>) => void
): Promise<Resolution> {
  let failedRounds = 0;
  for (;;) {
    const status = await querySignatureStatus(connection, signature);
    if (status.kind === "resolved") {
      return status.err !== null
        ? { type: "on-chain-error" }
        : { type: "confirmed" };
    }

    const height = await readBlockHeight(connection);
    if (height !== null && height > lastValidBlockHeight) {
      if (status.kind === "unobserved") {
        setRunState({
          status: "confirming",
          note: "Checking the chain for what actually landed...",
        });
        const verdict = await corroborateNonLanding(
          connection,
          signature,
          lastValidBlockHeight,
          candidate
        );
        switch (verdict.type) {
          case "standard-met":
            return { type: "expired-standard-met" };
          case "resolved":
            return verdict.err !== null
              ? { type: "on-chain-error" }
              : { type: "confirmed" };
          case "account-gone":
            return { type: "account-gone" };
          case "cannot-establish":
            return { type: "unresolved", detail: verdict.detail };
        }
      }
    }

    const unresolvable =
      status.kind === "rpc-failed" ||
      (status.kind === "unobserved" && height === null);
    if (unresolvable) {
      failedRounds += 1;
      if (failedRounds >= MAX_FAILED_ROUNDS) {
        return {
          type: "unresolved",
          detail: "the RPC could not be reached to establish the outcome",
        };
      }
    } else {
      failedRounds = 0;
    }
    await sleep(RESOLVE_POLL_INTERVAL_MS);
  }
}

const IN_FLIGHT_STATUSES: ReadonlySet<ExcessStatus> = new Set([
  "checking-current-state",
  "building",
  "awaiting-signature",
  "sending",
  "confirming",
  "verifying",
]);

export function useWithdrawExcess() {
  const connection = useRpcConnection();
  const wallet = useWallet();

  const [state, setState] = useState<ExcessState>(INITIAL_STATE);

  const withdrawInFlight = useRef(false);

  const livePublicKeyRef = useRef(wallet.publicKey);
  useEffect(() => {
    livePublicKeyRef.current = wallet.publicKey;
  }, [wallet.publicKey]);

  const statusRef = useRef<ExcessStatus>("idle");
  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  const withdraw = useCallback(
    async (candidate: ExcessCandidate) => {
      if (withdrawInFlight.current) return;
      withdrawInFlight.current = true;

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
        if (!acquireAction("excess")) {
          setState({
            ...INITIAL_STATE,
            status: "error",
            outcome: "action-conflict",
            error: "Another wallet action is underway. Wait for it to finish.",
          });
          return;
        }

        const actionOwner = wallet.publicKey;
        const signer = wallet.signTransaction;

        const setRunState = (
          patch:
            | Partial<ExcessState>
            | ((prev: ExcessState) => Partial<ExcessState>)
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
          excessAtDetection: candidate.excess,
          lamportsAtDetection: candidate.lamports,
        });

        // ---- The refresh gate (authoritative, in-lock) ----
        let gateRead: ExcessRead;
        try {
          gateRead = await readExcessState(connection, candidate.pubkey);
        } catch {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            error:
              "The current account state could not be read. Nothing was signed.",
          });
          return;
        }
        const verdict = evaluateExcessGate(gateRead);
        if (verdict.kind === "abort") {
          setRunState({
            status: "error",
            outcome: "gate-state-changed",
            error: verdict.sentence,
          });
          return;
        }
        if (verdict.kind === "already-gone") {
          setRunState({
            status: "done",
            outcome: "already-gone",
            lamportsAfterAction: null,
            error:
              "This account no longer exists. It may already have been closed. Nothing was signed.",
          });
          return;
        }
        if (verdict.kind === "already-withdrawn") {
          setRunState({
            status: "done",
            outcome: "already-withdrawn",
            lamportsAfterAction: gateRead.kind === "read" ? gateRead.lamports : null,
            error:
              "The account holds no excess lamports now. Nothing was signed.",
          });
          return;
        }
        // Excess drift vs the detection figure is NOT an abort (Case B):
        // the instruction drains whatever excess exists at land time,
        // and the card shows the current figure.
        setRunState({
          excessBeforeAction: verdict.excessBeforeAction,
          lamportsBeforeAction: verdict.lamportsBeforeAction,
        });

        // ---- Sign-and-resolve loop, with the single re-sign budget ----
        let reSignUsed = false;
        let refusalRetryUsed = false;
        let lastResolutionNote: string | null = null;

        const build = async () =>
          buildTransaction(connection, actionOwner, [
            buildWithdrawExcessInstruction(candidate, actionOwner),
          ]);

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
            const message =
              signError instanceof Error
                ? signError.message
                : String(signError);
            const lower = message.toLowerCase();
            if (lower.includes("rejected")) {
              throw new FriendlyError(
                "Transaction cancelled. Nothing was sent."
              );
            }
            if (/blockhash|block height|blockheight|expired/i.test(message)) {
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

          const lastValidBlockHeight = unsigned.lastValidBlockHeight!;
          try {
            await connection.sendRawTransaction(signed.serialize());
          } catch {
            // fall through to the evidence loop
          }

          setRunState({ status: "confirming" });
          const resolution = await resolveTransaction(
            connection,
            signature,
            lastValidBlockHeight,
            candidate,
            setRunState
          );

          if (resolution.type === "confirmed") {
            setRunState({ status: "verifying" });
            await sleep(RESOLVE_POLL_INTERVAL_MS);
            const tryVerificationRead = async (): Promise<ExcessRead> => {
              try {
                return await readExcessState(connection, candidate.pubkey);
              } catch {
                return { kind: "rpc-failed" };
              }
            };
            const firstRead = await tryVerificationRead();
            if (firstRead.kind === "read" && firstRead.excess <= 0) {
              setRunState({
                lamportsAfterAction: firstRead.lamports,
                status: "done",
                outcome: "withdraw-verified",
              });
              return;
            }
            if (firstRead.kind === "read") {
              // One spaced corroborating read before any scary
              // terminal: a lagging view must not produce one.
              await sleep(RESOLVE_POLL_INTERVAL_MS);
              const secondRead = await tryVerificationRead();
              if (secondRead.kind === "read" && secondRead.excess <= 0) {
                setRunState({
                  lamportsAfterAction: secondRead.lamports,
                  status: "done",
                  outcome: "withdraw-verified",
                });
                return;
              }
              if (secondRead.kind === "missing") {
                // Evidence, not a read failure: the account is gone
                // after a confirmed withdrawal-only transaction.
                // Causation is not claimed (the §8.9 discipline).
                setRunState({
                  lamportsAfterAction: null,
                  status: "done",
                  outcome: "unattributed",
                  error:
                    "The account is gone. Whether this app's transaction was involved could not be established.",
                });
                return;
              }
              if (secondRead.kind === "read") {
                setRunState({
                  lamportsAfterAction: secondRead.lamports,
                  status: "error",
                  outcome: "on-chain-failure",
                  error:
                    "The transaction was confirmed by the network, but a fresh read shows the same excess lamports still on the account. SOL.REPAIR cannot tell what happened. Nothing more will be sent automatically.",
                });
                return;
              }
              setRunState({
                lamportsAfterAction: null,
                status: "unverified",
                outcome: "confirmed-verification-unavailable",
                error:
                  "The transaction was confirmed by the network, but the follow-up read failed, so the withdrawal is unverified.",
              });
              return;
            }
            if (firstRead.kind === "missing") {
              setRunState({
                lamportsAfterAction: null,
                status: "done",
                outcome: "unattributed",
                error:
                  "The transaction was confirmed by the network, but a fresh read shows no account at this address. SOL.REPAIR cannot tell what happened. Nothing more will be sent automatically.",
              });
              return;
            }
            setRunState({
              lamportsAfterAction: null,
              status: "unverified",
              outcome: "confirmed-verification-unavailable",
              error:
                "The transaction was confirmed by the network, but the follow-up read failed, so the withdrawal is unverified.",
            });
            return;
          }

          if (resolution.type === "on-chain-error") {
            let lamportsAfter: number | null = null;
            try {
              const after = await readExcessState(
                connection,
                candidate.pubkey
              );
              if (after.kind === "read") lamportsAfter = after.lamports;
            } catch {
              // observation unavailable; stated as such
            }
            setRunState({
              status: "error",
              outcome: "on-chain-failure",
              lamportsAfterAction: lamportsAfter,
              error:
                "The transaction was confirmed on-chain but failed. It changed nothing.",
            });
            return;
          }

          if (resolution.type === "account-gone") {
            setRunState({
              status: "done",
              outcome: "unattributed",
              lamportsAfterAction: null,
              error:
                "The account is gone. Whether this app's transaction was involved could not be established.",
            });
            return;
          }

          if (resolution.type === "unresolved") {
            holdLockForDismissal = true;
            setRunState({
              status: "unverified",
              outcome: "unresolved-outcome",
              errorDetail: resolution.detail,
              error:
                "We could not verify whether the withdrawal landed. The transaction's outcome could not be established. It may still land. Nothing more will be sent automatically.",
            });
            return;
          }

          // expired-standard-met: provable non-landing, corroborated.
          if (reSignUsed) {
            let observation: ExcessRead | null = null;
            try {
              const after = await readExcessState(
                connection,
                candidate.pubkey
              );
              if (after.kind !== "rpc-failed") observation = after;
            } catch {
              // observation unavailable; stated as such
            }
            if (observation && observation.kind === "missing") {
              setRunState({
                status: "done",
                outcome: "unattributed",
                lamportsAfterAction: null,
                error:
                  "The account is gone. Whether this app's transaction was involved could not be established.",
              });
              return;
            }
            setRunState({
              status: "error",
              outcome: "expired",
              lamportsAfterAction:
                observation && observation.kind === "read"
                  ? observation.lamports
                  : null,
              error:
                observation === null
                  ? "The transaction expired again and was not retried further. The follow-up read failed, so the current state of the account is unknown."
                  : "The transaction expired again and was not retried further. When we checked, the account still held its lamports.",
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
            : "The withdrawal could not be prepared. Nothing was signed or sent.",
          errorDetail: friendly ? null : message,
        }));
      } finally {
        if (!holdLockForDismissal) {
          releaseAction("excess");
        }
        withdrawInFlight.current = false;
      }
    },
    [connection, wallet]
  );

  const reset = useCallback(() => {
    if (statusRef.current === "unverified" && heldAction() === "excess") {
      releaseAction("excess");
    }
    setState(INITIAL_STATE);
  }, []);

  const actionInFlight =
    IN_FLIGHT_STATUSES.has(state.status) ||
    // The unresolved terminal holds the mutex until the user
    // dismisses it (§8.11); the affordance must say so too.
    (state.status === "unverified" &&
      state.outcome === "unresolved-outcome");

  return { ...state, actionInFlight, withdraw, reset };
}
