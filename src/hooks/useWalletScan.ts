"use client";

/**
 * useWalletScan: React hook that auto-scans the connected wallet for
 * closeable token accounts whenever a wallet connects.
 *
 * This is the React bridge to getClosableAccounts() in lib/solana/. The
 * actual eligibility logic lives in the lib layer; this hook just calls it
 * and exposes the result.
 *
 * Design notes:
 * - No setState is called synchronously inside the effect (React's
 *   set-state-in-effect rule). Instead, each scan result is tagged with the
 *   wallet public key it belongs to, and the public state (loading/result/
 *   error) is DERIVED by comparing that tag to the currently connected
 *   wallet. A result from a previous wallet can never leak into the view.
 * - "loading" means: a wallet is connected and we do not yet have a
 *   completed scan (success or error) for that exact wallet.
 * - rescan() re-runs the scan for the connected wallet. Needed because the
 *   scan result goes STALE the moment a repair closes accounts: without a
 *   rescan, the UI would keep offering to repair accounts that are already
 *   closed.
 */

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  getClosableAccounts,
  type ScanResult,
} from "@/lib/solana/tokenAccounts";

interface TaggedScan {
  /** The wallet this scan belongs to (base58). Stale tags are ignored. */
  ownerKey: string;
  result: ScanResult | null;
  error: string | null;
}

const NO_SCAN: TaggedScan = { ownerKey: "", result: null, error: null };

export function useWalletScan(): {
  loading: boolean;
  result: ScanResult | null;
  error: string | null;
  rescan: () => void;
} {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const ownerKey = publicKey?.toBase58() ?? "";

  const [scan, setScan] = useState<TaggedScan>(NO_SCAN);
  // Bumped by rescan() to re-trigger the effect for the same wallet.
  const [refreshTick, setRefreshTick] = useState(0);

  const rescan = useCallback(() => {
    // Drop the stored outcome so "loading" shows immediately and the stale
    // result is not displayed while the fresh scan is in flight.
    setScan(NO_SCAN);
    setRefreshTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!ownerKey || !publicKey) return;

    let cancelled = false;

    getClosableAccounts(connection, publicKey)
      .then((result) => {
        if (!cancelled) {
          setScan({ ownerKey, result, error: null });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setScan({
            ownerKey,
            result: null,
            error: err instanceof Error ? err.message : "Scan failed.",
          });
        }
      });

    // If the wallet disconnects or changes mid-scan, ignore the stale
    // result. The ownerKey tag also makes it impossible to display.
    return () => {
      cancelled = true;
    };
  }, [connection, ownerKey, publicKey, refreshTick]);

  // Derive the public state. A stored scan only counts if it belongs to the
  // currently connected wallet.
  const isCurrent = scan.ownerKey === ownerKey && ownerKey !== "";
  const hasOutcome = scan.result !== null || scan.error !== null;

  return {
    loading: ownerKey !== "" && !(isCurrent && hasOutcome),
    result: isCurrent ? scan.result : null,
    error: isCurrent ? scan.error : null,
    rescan,
  };
}
