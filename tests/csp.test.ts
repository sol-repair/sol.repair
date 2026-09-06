import { describe, expect, it } from "vitest";
import { buildCspHeader } from "../src/lib/security/csp";

describe("buildCspHeader", () => {
  it("always carries the core hardening directives", () => {
    const header = buildCspHeader();
    expect(header).toContain("default-src 'self'");
    expect(header).toContain("object-src 'none'");
    expect(header).toContain("base-uri 'self'");
    expect(header).toContain("form-action 'self'");
    expect(header).toContain("frame-ancestors 'none'");
    expect(header).toContain("upgrade-insecure-requests");
  });

  it("keeps inline scripts and styles allowed for static Next.js pages", () => {
    const header = buildCspHeader();
    expect(header).toContain("script-src 'self' 'unsafe-inline'");
    expect(header).toContain("style-src 'self' 'unsafe-inline'");
    expect(header).toContain("img-src 'self' data:");
    expect(header).toContain("font-src 'self'");
  });

  it("allows eval only for development builds", () => {
    expect(buildCspHeader({ isDev: true })).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    );
    expect(buildCspHeader({ isDev: false })).not.toContain("'unsafe-eval'");
  });

  it("allows the three public Solana RPC origins by default", () => {
    const header = buildCspHeader();
    expect(header).toContain("connect-src 'self'");
    expect(header).toContain("https://api.mainnet-beta.solana.com");
    expect(header).toContain("https://api.devnet.solana.com");
    expect(header).toContain("https://api.testnet.solana.com");
  });

  it("adds the dedicated provider origin when an endpoint is configured", () => {
    const header = buildCspHeader({
      providerRpcEndpoint: "https://rpc.example-provider.com/abc123",
    });
    expect(header).toContain("https://rpc.example-provider.com");
  });

  it("ignores a malformed provider endpoint instead of throwing", () => {
    const header = buildCspHeader({ providerRpcEndpoint: "not a url" });
    expect(header).not.toContain("not a url");
  });

  it("does not duplicate a provider that matches a public origin", () => {
    const header = buildCspHeader({
      providerRpcEndpoint: "https://api.devnet.solana.com/",
    });
    const devnetMatches = header.split(" ").filter((t) => t.includes("api.devnet")).length;
    expect(devnetMatches).toBe(1);
  });
});
