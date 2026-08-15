"use client";

/**
 * SolanaProvider wraps the application and provides:
 *   - the RPC connection (which network the app talks to)
 *   - the wallet state (connected wallet, public key, etc.)
 *
 * The network is sourced from src/lib/solana/connection.ts, which reads the
 * NEXT_PUBLIC_SOLANA_NETWORK environment variable. The default is devnet so a missing
 * env var can never route the app at mainnet.
 */

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { useMemo, type ReactNode } from "react";

// Default styling for the wallet adapter modal. This import is required for
// the prebuilt WalletMultiButton and modal to render correctly.
import "@solana/wallet-adapter-react-ui/styles.css";

import { RPC_ENDPOINT } from "@/lib/solana/connection";

export function SolanaProvider({ children }: { children: ReactNode }) {
  // Endpoint is stable for the life of the app; memoize so the connection is
  // not torn down and recreated on every render.
  const endpoint = useMemo(() => RPC_ENDPOINT, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      {/* wallets={[]} uses Wallet Standard auto-discovery: Phantom, Solflare,
          Backpack, etc. are detected in the browser without bundling legacy
          wallet-specific adapters.

          autoConnect is off on purpose. A wallet silently reconnecting on
          page load reads like the opening move of a drainer flow. Returning
          users click connect once. */}
      <WalletProvider wallets={[]}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
