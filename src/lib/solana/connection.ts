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
 *
 * IMPORTANT: these are read as LITERAL process.env references at module
 * scope, because Next.js inlines only literal NEXT_PUBLIC_* references
 * into the browser bundle - dynamic access (env[variableKey]) compiles
 * to undefined in the client and the list would silently degrade to the
 * public endpoint.
 */
const CONFIGURED_LISTS: Record<SolanaNetwork, string | undefined> = {
  localhost: process.env.NEXT_PUBLIC_LOCALHOST_RPC_ENDPOINTS,
  devnet: process.env.NEXT_PUBLIC_DEVNET_RPC_ENDPOINTS,
  "mainnet-beta": process.env.NEXT_PUBLIC_MAINNET_RPC_ENDPOINTS,
  testnet: process.env.NEXT_PUBLIC_TESTNET_RPC_ENDPOINTS,
};

const LEGACY_MAINNET_ENDPOINT = process.env.NEXT_PUBLIC_MAINNET_RPC_ENDPOINT;

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
 *   1. the network's configured provider list, if set
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
  configuredLists: Partial<Record<SolanaNetwork, string | undefined>>,
  legacyMainnetEndpoint: string | undefined
): string[] {
  const configured = parseEndpointList(configuredLists[network]);
  const legacy =
    network === "mainnet-beta"
      ? parseEndpointList(legacyMainnetEndpoint)
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
 * the rest are failover targets, wired per-call through rpc.ts's
 * useRpcConnection (M9): a transport-shaped failure on one endpoint
 * rotates the same call to the next, with the public endpoint as the
 * built-in safety net.
 */
export const RPC_ENDPOINTS: string[] = getRpcEndpoints(
  SOLANA_NETWORK,
  CONFIGURED_LISTS,
  LEGACY_MAINNET_ENDPOINT
);

/**
 * The primary endpoint: the first entry of the ordered list. Existing
 * consumers (the wallet provider, the fee ledger) keep this contract.
 */
export const RPC_ENDPOINT: string = RPC_ENDPOINTS[0];

/**
 * Origins of every endpoint in the active list, for the CSP connect-src
 * allowlist: the browser must be able to reach the primary AND every
 * documented failover target. Malformed entries contribute nothing.
 */
export function getRpcEndpointOrigins(): string[] {
  const origins = new Set<string>();
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const origin = new URL(endpoint).origin;
      if (origin.startsWith("http://") || origin.startsWith("https://")) {
        origins.add(origin);
      }
    } catch {
      // A malformed endpoint contributes nothing to the allowlist.
    }
  }
  return [...origins];
}
