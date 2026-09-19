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
 * Fetch depth is the owner-decided 25 (the ledger's page size); a
 * connected wallet on a busy chain shows its newest 25, and pagination
 * is a later milestone if it is ever wanted.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletPicker } from "@/components/WalletButton";
import { fetchFeeSignatures, formatBlockTime } from "@/lib/solana/feeLedger";

const emptySubscribe = () => () => {};

const NO_WALLET_MESSAGE =
  "No Solana wallet detected in this browser. Open sol.repair inside the browser built into the Phantom or Solflare app, or use a desktop browser with your wallet's extension installed.";

const CONNECT_FAILED_MESSAGE =
  "Couldn't connect to this wallet. If it keeps failing, open sol.repair inside your wallet's own browser and try again.";

type TxListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; detail: string }
  | {
      kind: "done";
      items: { signature: string; blockTime: number | null }[];
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
  const [result, setResult] = useState<{
    address: string;
    state: TxListState;
  } | null>(null);

  const address = connected && publicKey ? publicKey.toBase58() : null;

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetchFeeSignatures(endpoint, address)
      .then((items) => {
        if (!cancelled) {
          setResult({ address, state: { kind: "done", items } });
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
    const label = wallet
      ? connecting
        ? "Connecting..."
        : "Connect to list your recent transactions"
      : "Connect to list your recent transactions";
    return (
      <>
        <button
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
          {label}
        </button>
        {errorLine}
        {pickerOpen && <WalletPicker onClose={() => setPickerOpen(false)} />}
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
          className="font-mono text-xs text-zinc-500 hover:text-zinc-300"
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
          <p className="mt-1 break-all text-xs text-zinc-500">{list.detail}</p>
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
                className="w-full rounded px-2 py-2 text-left font-mono text-xs text-zinc-300 transition-colors hover:bg-zinc-800/60"
              >
                {item.signature.slice(0, 8)}…{item.signature.slice(-4)}
                <span className="ml-3 text-zinc-500">
                  {formatBlockTime(item.blockTime)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
