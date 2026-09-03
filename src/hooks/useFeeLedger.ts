"use client";

/**
 * React layer for the fee ledger page.
 *
 * Fetches the ledger from the public RPC in the browser, caches page 1 in
 * localStorage with a short TTL (render cache instantly, revalidate in
 * the background), and keeps an honest "updated Xs ago" timestamp. No
 * backend, no server-side cache — the page's verification story depends
 * on exactly that.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { DEV_FEE_WALLET, MAINNET_FEE_WALLET } from "@/lib/solana/fees";
import {
  FEE_LEDGER_ENDPOINTS,
  FEE_LEDGER_PAGE_SIZE,
  LedgerFetchError,
  fetchFeeLedgerPage,
  type FeeLedgerCluster,
  type FeeLedgerRow,
} from "@/lib/solana/feeLedger";

const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  rows: FeeLedgerRow[];
  fetchedAt: number;
  lastSignature: string | null;
  hasMore: boolean;
};

function cacheKey(cluster: FeeLedgerCluster): string {
  // v3: rows now carry onePercentMatch; v2-cached rows lack the field and
  // would render untagged for the cache's TTL, so they are invalidated
  // rather than trusted. (v2 had moved pagination metadata from fee-row-
  // based to raw-signature-based for the same reason.)
  return `solrepair:fee-ledger:v3:${cluster}`;
}

function readCache(cluster: FeeLedgerCluster): CacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey(cluster));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (typeof entry.fetchedAt !== "number" || !Array.isArray(entry.rows)) {
      return null;
    }
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(cluster: FeeLedgerCluster, entry: CacheEntry): void {
  try {
    localStorage.setItem(cacheKey(cluster), JSON.stringify(entry));
  } catch {
    // Storage can be unavailable (private mode, quota). The ledger then
    // simply fetches fresh every visit; not an error worth showing.
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof LedgerFetchError && e.kind === "rate-limited") {
    return "RPC rate limited — give it a few seconds.";
  }
  return "Could not reach the RPC. Check your connection and retry.";
}

export function useFeeLedger() {
  const [cluster, setCluster] = useState<FeeLedgerCluster>("mainnet-beta");
  const [rows, setRows] = useState<FeeLedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  // Bumped by reload(); the effect treats it as a fresh fetch that
  // bypasses the cache (a retry must not re-show the failed view).
  const [reloadTick, setReloadTick] = useState(0);
  const skipCache = useRef(false);

  // Ticker for the honest "updated Xs ago" label.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const feeWallet = (
    cluster === "mainnet-beta" ? MAINNET_FEE_WALLET : DEV_FEE_WALLET
  ).toBase58();
  const endpoint = FEE_LEDGER_ENDPOINTS[cluster];

  // Up to two automatic retries when the RPC is rate-limited: the public
  // endpoints' throttles release within seconds, so the page shows the
  // honest "give it a few seconds" state and retries a couple of times on
  // its own before asking the user to click Retry. The counter keeps a
  // persistently throttled endpoint from retrying forever (each retry is a
  // fresh burst of fetches, which would keep the throttle warm); the Retry
  // button resets the allowance.
  const autoRetryCount = useRef(0);
  const autoRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    autoRetryCount.current = 0;
  }, [cluster]);

  const reload = useCallback(() => {
    skipCache.current = true;
    autoRetryCount.current = 0;
    setError(null);
    setReloadTick((t) => t + 1);
  }, []);

  // Auto-retry variant of reload: same fresh fetch, but keeps the retry
  // budget so a dead endpoint eventually stops trying.
  const autoRetry = useCallback(() => {
    skipCache.current = true;
    setError(null);
    setReloadTick((t) => t + 1);
  }, []);

  // Load page 1 whenever the cluster changes (or reload is requested).
  // A stale async response can never write state: the generation counter
  // makes the previous effect's in-flight fetch inert.
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    const cached = skipCache.current ? null : readCache(cluster);
    skipCache.current = false;
    const background = cached !== null;

    if (cached) {
      setRows(cached.rows);
      setFetchedAt(cached.fetchedAt);
      setHasMore(cached.hasMore);
      setLastSignature(cached.lastSignature);
      setError(null);
      setLoading(false);
    } else {
      setRows([]);
      setFetchedAt(null);
      setHasMore(false);
      setLastSignature(null);
      setError(null);
      setLoading(true);
    }

    void (async () => {
      try {
        const page = await fetchFeeLedgerPage(endpoint, feeWallet);
        if (generation.current !== gen) return;
        const fetchedAt = Date.now();
        // Pagination is judged on the RAW signature page, not the filtered
        // fee rows: a full 25-signature page can hold zero fees without
        // that meaning the wallet history is exhausted.
        const nextHasMore = page.rawSignatureCount === FEE_LEDGER_PAGE_SIZE;
        const nextLast = page.lastRawSignature;
        setRows(page.rows);
        setLastSignature(nextLast);
        setHasMore(nextHasMore);
        setFetchedAt(fetchedAt);
        setError(null);
        setLoading(false);
        writeCache(cluster, {
          rows: page.rows,
          fetchedAt,
          lastSignature: nextLast,
          hasMore: nextHasMore,
        });
      } catch (e) {
        if (generation.current !== gen) return;
        if (!background) {
          setLoading(false);
          setError(errorMessage(e));
          if (
            e instanceof LedgerFetchError &&
            e.kind === "rate-limited" &&
            autoRetryCount.current < 2
          ) {
            autoRetryCount.current += 1;
            autoRetryTimer.current = setTimeout(() => {
              autoRetryTimer.current = null;
              autoRetry();
            }, 4000);
          }
        }
        // A failed background revalidate keeps the cached view; silent.
      }
    })();

    return () => {
      // Invalidate any in-flight response from this effect run. A stale
      // fetch must never write state after a cluster switch or unmount.
      generation.current = gen + 1;
      if (autoRetryTimer.current) {
        clearTimeout(autoRetryTimer.current);
        autoRetryTimer.current = null;
      }
    };
  }, [autoRetry, cluster, endpoint, feeWallet, reload, reloadTick]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !lastSignature) return;
    setLoadingMore(true);
    setError(null);
    // Take the generation ticket the initial fetch uses: if the
    // cluster changes (or a reload starts) while this fetch is in
    // flight, the ticket is stale when the response lands, and a
    // stale response must never write rows or cursor into the new
    // view.
    const gen = generation.current;
    try {
      const page = await fetchFeeLedgerPage(endpoint, feeWallet, lastSignature);
      if (generation.current !== gen) return;
      // Cursor and hasMore from the raw signature page: a page of 25 raw
      // signatures with zero fee rows must still advance the cursor, and
      // only an empty RAW page means the history is exhausted.
      const nextLast = page.lastRawSignature;
      const nextHasMore = page.rawSignatureCount === FEE_LEDGER_PAGE_SIZE;
      if (!nextLast) {
        setHasMore(false);
        return;
      }
      // The next page can re-serve the boundary signature the cursor
      // already paged past (node-side pagination inconsistency). A row
      // the view already shows must never be appended again - the public
      // total would double-count the fee.
      const known = new Set(rows.map((r) => r.signature));
      const fresh = page.rows.filter((r) => !known.has(r.signature));
      const next = [...rows, ...fresh];
      setRows(next);
      setLastSignature(nextLast);
      setHasMore(nextHasMore);
      setFetchedAt(Date.now());
      writeCache(cluster, {
        rows: next,
        fetchedAt: Date.now(),
        lastSignature: nextLast,
        hasMore: nextHasMore,
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }, [cluster, endpoint, feeWallet, lastSignature, loadingMore, rows]);

  const totalLamports = rows.reduce((sum, row) => sum + row.lamports, 0);

  return {
    cluster,
    setCluster,
    rows,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    reload,
    fetchedAt,
    now,
    feeWallet,
    totalLamports,
  };
}
