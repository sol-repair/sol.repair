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
 * RPC endpoint for the active network.
 *
 * Uses the public Solana endpoints by default. For production you would
 * override this with a dedicated RPC (Helius, QuickNode, Triton, etc.) via
 * NEXT_PUBLIC_RPC_ENDPOINT, but for devnet development the public endpoint is
 * fine and keeps the project free to run.
 */
const PUBLIC_ENDPOINTS: Record<SolanaNetwork, string> = {
  // Local test validator (solana-test-validator). For development only.
  localhost: "http://localhost:8899",
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  testnet: "https://api.testnet.solana.com",
};

// TODO: point mainnet builds at a dedicated RPC before launch, not the
// public endpoint.
export const RPC_ENDPOINT: string =
  process.env.NEXT_PUBLIC_RPC_ENDPOINT || PUBLIC_ENDPOINTS[SOLANA_NETWORK];
