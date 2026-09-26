"use client";

/**
 * Read-only recent-transactions walk (M4a).
 *
 * Lists a connected wallet's newest signatures so they can be explained
 * without hunting for something to paste. Read-only forever: the only
 * wallet calls this component makes are connect and disconnect, and the
 * suite pins that signTransaction and sendTransaction are never invoked
 * anywhere in the walk.
 *
 * The first page is the ledger's page size (25); a full page means older
 * transactions may exist, so a Load more control walks back one page at a
 * time with the previous page's last signature as the cursor.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  CONNECT_FAILED_MESSAGE,
  NO_WALLET_MESSAGE,
  WalletPicker,
} from "@/components/WalletButton";
import {
  FEE_LEDGER_PAGE_SIZE,
  fetchFeeSignatures,
  formatBlockTime,
} from "@/lib/solana/feeLedger";

const emptySubscribe = () => () => {};

type TxListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; detail: string }
  | {
      kind: "done";
      items: { signature: string; blockTime: number | null }[];
      /** False while the page was full, meaning older transactions may
       *  still exist and a Load more control belongs on screen. */
      reachedEnd: boolean;
    };

export function WalletRecentTransactions({
  endpoint,
  onSelect,
}: {
  endpoint: string;
  onSelect: (signature: string) => void;
}) {
  const isClient = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
  const { wallet, wallets, connect, connected, connecting, disconnect, publicKey } =
    useWallet();
  const [walletError, setWalletError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const connectTriggerRef = useRef<HTMLButtonElement>(null);
  const [result, setResult] = useState<{
    address: string;
    state: TxListState;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  // Whatever closes the picker - Cancel, Escape, the overlay, or a
  // completed pick - returns focus to the control that opened it.
  // Same contract as the homepage's wallet picker.
  const closePicker = () => {
    setPickerOpen(false);
    connectTriggerRef.current?.focus();
  };

  const address = connected && publicKey ? publicKey.toBase58() : null;

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetchFeeSignatures(endpoint, address)
      .then((items) => {
        if (!cancelled) {
          setResult({
            address,
            state: {
              kind: "done",
              items,
              reachedEnd: items.length < FEE_LEDGER_PAGE_SIZE,
            },
          });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setResult({
          address,
          state: {
            kind: "error",
            detail: error instanceof Error ? error.message : String(error),
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [address, endpoint]);

  const currentList =
    address && result && result.address === address ? result.state : null;

  async function loadMore() {
    if (!address || !currentList || currentList.kind !== "done") return;
    if (currentList.items.length === 0) return;
    const before = currentList.items[currentList.items.length - 1].signature;
    setMoreError(null);
    setLoadingMore(true);
    try {
      const next = await fetchFeeSignatures(endpoint, address, before);
      setResult({
        address,
        state: {
          kind: "done",
          items: [...currentList.items, ...next],
          reachedEnd: next.length < FEE_LEDGER_PAGE_SIZE,
        },
      });
    } catch (error) {
      setMoreError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingMore(false);
    }
  }

  // Derived, never stored: loading while no result exists for the
  // current address, idle while disconnected, and a result for an old
  // address is ignored rather than flashed.
  const list: TxListState = !address
    ? { kind: "idle" }
    : result && result.address === address
      ? result.state
      : { kind: "loading" };

  if (!isClient) return null;

  const base =
    "w-full rounded-lg px-4 py-3 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

  const errorLine = walletError && !connected ? (
    <p className="mt-2 text-xs leading-relaxed text-zinc-400" role="alert">
      {walletError}
    </p>
  ) : null;

  if (!address) {
    const label = connecting
      ? "Connecting..."
      : wallet
        ? `Connect ${wallet.adapter.name} to list your recent transactions`
        : "Connect to list your recent transactions";
    return (
      <>
        <button
          ref={connectTriggerRef}
          onClick={() => {
            setWalletError(null);
            if (wallet) {
              connect().catch(() => setWalletError(CONNECT_FAILED_MESSAGE));
              return;
            }
            if (wallets.length === 0) {
              setWalletError(NO_WALLET_MESSAGE);
              return;
            }
            setPickerOpen(true);
          }}
          disabled={connecting}
          className={`${base} bg-[#14F195] text-black hover:bg-[#0fd584]`}
        >
          <span className="inline-flex items-center justify-center gap-2">
            {wallet?.adapter.icon && !connecting && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={wallet.adapter.icon} alt="" className="h-5 w-5" />
            )}
            {label}
          </span>
        </button>
        {errorLine}
        {pickerOpen && <WalletPicker onClose={closePicker} />}
      </>
    );
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-200">
          Your most recent transactions
        </p>
        <button
          onClick={() => disconnect()}
          title="Disconnect wallet"
          className="font-mono text-xs text-zinc-400 hover:text-zinc-300"
        >
          {address.slice(0, 4)}…{address.slice(-4)} · disconnect
        </button>
      </div>

      {list.kind === "loading" && (
        <p className="mt-3 text-sm text-zinc-400">
          Reading your transaction history...
        </p>
      )}

      {list.kind === "error" && (
        <div className="mt-3">
          <p className="text-sm text-red-400">Could not reach the RPC.</p>
          <p className="mt-1 break-all text-xs text-zinc-400">{list.detail}</p>
        </div>
      )}

      {list.kind === "done" && list.items.length === 0 && (
        <p className="mt-3 text-sm text-zinc-300">
          No transactions found for this wallet on this network.
        </p>
      )}

      {list.kind === "done" && list.items.length > 0 && (
        <ul className="mt-3 space-y-1">
          {list.items.map((item) => (
            <li key={item.signature}>
              <button
                onClick={() => onSelect(item.signature)}
                className="flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left font-mono text-xs text-zinc-300 transition-colors hover:bg-zinc-800/60"
              >
                <span className="truncate">
                  {item.signature.slice(0, 8)}…{item.signature.slice(-4)}
                </span>
                <span className="shrink-0 tabular-nums text-zinc-400">
                  {formatBlockTime(item.blockTime)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {list.kind === "done" && list.items.length > 0 && !list.reachedEnd && (
        <button
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="mt-3 w-full rounded border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800/60 disabled:opacity-60"
        >
          {loadingMore ? "Loading more..." : "Load more"}
        </button>
      )}

      {moreError && (
        <div className="mt-3">
          <p className="text-sm text-red-400">Could not reach the RPC.</p>
          <p className="mt-1 break-all text-xs text-zinc-400">{moreError}</p>
        </div>
      )}
    </div>
  );
}
