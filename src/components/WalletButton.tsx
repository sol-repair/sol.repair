"use client";

/**
 * WalletButton: custom connect button.
 *
 * The stock WalletMultiButton has hardcoded labels ("Select Wallet",
 * "Connect"), and the word "Connect" alone doesn't say what the connection
 * is FOR. Every label here states the purpose: read-only scanning. The
 * label itself builds trust.
 *
 * useSyncExternalStore gives us a hydration-safe "are we on the client
 * yet" value: the server snapshot is false, the client snapshot is true,
 * and React reconciles the two without an effect or a state update.
 */

import { useSyncExternalStore, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

const emptySubscribe = () => () => {};

/**
 * Two dead ends need plain words instead of silence: a browser that
 * exposes no detectable Solana wallet (some mobile browsers, Brave on
 * iPhone among them), and a wallet whose connect() call fails. Both get
 * one sentence that tells the user the way out.
 */
const NO_WALLET_MESSAGE =
  "No Solana wallet detected in this browser. Open sol.repair inside the browser built into the Phantom or Solflare app, or use a desktop browser with your wallet's extension installed.";

const CONNECT_FAILED_MESSAGE =
  "Couldn't connect to this wallet. If it keeps failing, open sol.repair inside your wallet's own browser and try again.";

export function WalletButton() {
  const isClient = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
  const { wallet, wallets, connect, connected, connecting, disconnect, publicKey } =
    useWallet();
  const modal = useWalletModal();
  const [walletError, setWalletError] = useState<string | null>(null);

  if (!isClient) {
    // Placeholder that reserves roughly the button's space so the layout
    // does not jump when the real button loads.
    return (
      <div
        className="h-[44px] w-full rounded-lg bg-zinc-900"
        aria-hidden="true"
      />
    );
  }

  const base =
    "w-full rounded-lg px-4 py-3 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

  const errorLine =
    walletError && !connected ? (
      <p className="mt-2 text-xs leading-relaxed text-zinc-400" role="alert">
        {walletError}
      </p>
    ) : null;

  if (connected && publicKey) {
    return (
      <button
        onClick={() => disconnect()}
        title="Disconnect wallet"
        className={`${base} border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800`}
      >
        Connected: {publicKey.toBase58().slice(0, 4)}…
        {publicKey.toBase58().slice(-4)} · click to disconnect
      </button>
    );
  }

  if (wallet) {
    return (
      <>
        <button
          onClick={() => {
            setWalletError(null);
            connect().catch(() => setWalletError(CONNECT_FAILED_MESSAGE));
          }}
          disabled={connecting}
          className={`${base} bg-[#14F195] text-black hover:bg-[#0fd584]`}
        >
          {connecting ? "Connecting..." : "Connect to Scan Accounts"}
        </button>
        {errorLine}
      </>
    );
  }

  return (
    <>
      <button
        onClick={() => {
          setWalletError(null);
          if (wallets.length === 0) {
            setWalletError(NO_WALLET_MESSAGE);
            return;
          }
          modal.setVisible(true);
        }}
        className={`${base} bg-[#14F195] text-black hover:bg-[#0fd584]`}
      >
        Select Wallet
      </button>
      {errorLine}
    </>
  );
}
