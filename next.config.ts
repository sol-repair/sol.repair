import type { NextConfig } from "next";
import { buildCspHeader } from "./src/lib/security/csp";
import { getRpcEndpointOrigins } from "./src/lib/solana/connection";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Baseline browser security headers for a wallet tool. HSTS is
        // already added by Vercel at the edge. The CSP is the moderate,
        // static-preserving policy (see src/lib/security/csp.ts); it must
        // survive the real-wallet devnet poke (Phantom, Solflare, Brave)
        // before it ever ships to main.
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: buildCspHeader({
              isDev: process.env.NODE_ENV === "development",
              // Every origin in the active network's ordered endpoint
              // list: the browser must reach the primary and each
              // documented failover target.
              providerRpcEndpoints: getRpcEndpointOrigins(),
            }),
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
