import type { NextConfig } from "next";
import { buildCspHeader } from "./src/lib/security/csp";

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
              providerRpcEndpoint: process.env.NEXT_PUBLIC_MAINNET_RPC_ENDPOINT,
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
