/**
 * useRpcConnection: the failover-aware RPC connection for consumers.
 *
 * Wraps the wallet-adapter's primary connection (the first configured
 * endpoint) with M9 per-call failover across the remaining endpoints in
 * the ordered list. With a single configured endpoint the primary is
 * returned untouched, so behavior is identical to before M9 there.
 */

import { useConnection } from "@solana/wallet-adapter-react";
import { useMemo } from "react";
import type { Connection } from "@solana/web3.js";

import { RPC_ENDPOINT, RPC_ENDPOINTS } from "@/lib/solana/connection";
import { wrapWithFailover } from "@/lib/solana/rpc";

export function useRpcConnection(): Connection {
  const { connection } = useConnection();
  return useMemo(
    () => wrapWithFailover(connection, RPC_ENDPOINT, RPC_ENDPOINTS),
    [connection]
  );
}
