/**
 * Solana network configuration. Everything Solana-specific lives under
 * src/lib/solana/ so the UI never touches web3.js primitives directly.
 *
 * The network is chosen by environment variable, never hardcoded. This is
 * the single point where the devnet/mainnet decision happens, so switching
 * to mainnet is an explicit config change, not an accidental one.
 */

export type SolanaNetwork = "localhost" | "devnet" | "mainnet-beta" | "testnet";

function isNetwork(value: string | undefined): value is SolanaNetwork {
  return (
    value === "localhost" ||
    value === "devnet" ||
    value === "mainnet-beta" ||
    value === "testnet"
  );
}

// NOTE: this file is imported by client components, so the env var MUST carry
// the NEXT_PUBLIC_ prefix. Without it, the browser bundle sees `undefined`
// and silently falls back to the devnet default.
const env = process.env.NEXT_PUBLIC_SOLANA_NETWORK;

/**
 * The active Solana network. Defaults to devnet so that a missing or mistyped
 * environment variable can never accidentally route the app at mainnet.
 */
export const SOLANA_NETWORK: SolanaNetwork = isNetwork(env) ? env : "devnet";

/**
 * Human-readable label shown in the UI so the active network is impossible to
 * confuse. Per the spec, devnet must be displayed prominently during
 * development.
 */
export const NETWORK_LABEL: string =
  SOLANA_NETWORK === "mainnet-beta" ? "MAINNET" : SOLANA_NETWORK.toUpperCase();

/**
 * Whether the app is currently pointed at real money. Used to gate UI elements
 * (e.g. showing a DEVNET badge) and to make defensive assertions in code.
 */
export const IS_MAINNET: boolean = SOLANA_NETWORK === "mainnet-beta";

/**
 * Public Solana endpoints, the always-present last entry of every
 * network's endpoint list. The mainnet build can be pointed at dedicated
 * providers instead; see getRpcEndpoints below.
 */
const PUBLIC_ENDPOINTS: Record<SolanaNetwork, string> = {
  // Local test validator (solana-test-validator). For development only.
  localhost: "http://localhost:8899",
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  testnet: "https://api.testnet.solana.com",
};

/**
 * Comma-separated provider endpoint lists, ordered most-preferred first.
 * Set per deployment via Vercel env vars. Values are quota keys and ship
 * to the browser (NEXT_PUBLIC_ prefix), exactly like the legacy single
 * endpoint they extend.
 */
const ENV_VAR_BY_NETWORK: Record<SolanaNetwork, string> = {
  localhost: "NEXT_PUBLIC_LOCALHOST_RPC_ENDPOINTS",
  devnet: "NEXT_PUBLIC_DEVNET_RPC_ENDPOINTS",
  "mainnet-beta": "NEXT_PUBLIC_MAINNET_RPC_ENDPOINTS",
  testnet: "NEXT_PUBLIC_TESTNET_RPC_ENDPOINTS",
};

/**
 * Split a comma-separated endpoint list: trimmed, empties dropped,
 * duplicates removed, order preserved.
 */
export function parseEndpointList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "" || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * The network's ordered endpoint list. Entries, in order:
 *   1. the network's NEXT_PUBLIC_<NETWORK>_RPC_ENDPOINTS list, if set
 *   2. mainnet only: the legacy NEXT_PUBLIC_MAINNET_RPC_ENDPOINT single
 *      override, kept working until deployments move to the list variable
 *   3. the public cluster endpoint, always last, so a misconfigured
 *      provider degrades to the public endpoint instead of nothing
 *
 * A network can never inherit another network's override: the list is
 * keyed by the network, and the legacy mainnet variable is read only
 * when the network is mainnet-beta.
 */
export function getRpcEndpoints(
  network: SolanaNetwork,
  env: Record<string, string | undefined>
): string[] {
  const configured = parseEndpointList(env[ENV_VAR_BY_NETWORK[network]]);
  const legacy =
    network === "mainnet-beta"
      ? parseEndpointList(env.NEXT_PUBLIC_MAINNET_RPC_ENDPOINT)
      : [];
  const out: string[] = [];
  for (const endpoint of [...configured, ...legacy, PUBLIC_ENDPOINTS[network]]) {
    if (!out.includes(endpoint)) out.push(endpoint);
  }
  return out;
}

/**
 * The active network's ordered endpoint list. The first entry is the
 * primary connection used by the wallet provider and every RPC read;
 * the rest are documented failover targets (per-call failover is a
 * tracked follow-up - today the list defines the order deployments
 * prefer, with the public endpoint as the built-in safety net).
 */
export const RPC_ENDPOINTS: string[] = getRpcEndpoints(SOLANA_NETWORK, process.env);

/**
 * The primary endpoint: the first entry of the ordered list. Existing
 * consumers (the wallet provider, the fee ledger) keep this contract.
 */
export const RPC_ENDPOINT: string = RPC_ENDPOINTS[0];
