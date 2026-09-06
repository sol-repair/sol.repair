// Content Security Policy builder for the static Next.js site.
//
// This is the deliberate "moderate" policy, not the strict nonce variant:
// a strict script-src would force every page to be dynamically rendered
// (the bundled Next.js CSP guide says nonces require dynamic rendering),
// costing the site its prerendered pages. Scripts and styles therefore
// keep 'unsafe-inline': Next.js injects its own inline bootstrap scripts
// and next/font injects inline font styles. The site has no input surface,
// so script injection would require a compromised build, which script-src
// 'self' plus the connect-src allowlist still contain. Wallet extensions
// (Phantom, Solflare, Brave) run in the browser's isolated world and are
// not governed by this header; any carve-out they turn out to need gets
// added only after the real-wallet devnet poke proves it.

const PUBLIC_RPC_ORIGINS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.devnet.solana.com",
  "https://api.testnet.solana.com",
];

export function buildCspHeader({
  isDev = false,
  providerRpcEndpoint,
}: {
  isDev?: boolean;
  providerRpcEndpoint?: string;
} = {}): string {
  const connectOrigins = new Set<string>(["'self'", ...PUBLIC_RPC_ORIGINS]);
  if (providerRpcEndpoint) {
    try {
      const origin = new URL(providerRpcEndpoint).origin;
      if (origin.startsWith("http://") || origin.startsWith("https://")) {
        connectOrigins.add(origin);
      }
    } catch {
      // A malformed endpoint contributes nothing to the allowlist.
    }
  }

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${[...connectOrigins].join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ];

  return directives.join("; ");
}
