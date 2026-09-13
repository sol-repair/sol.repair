/**
 * RPC endpoint list tests (connection.ts).
 *
 * The app talks to ONE ordered endpoint list per network. The first entry
 * is the primary (a provider endpoint when configured); the public
 * cluster endpoint is always the last entry so a misconfigured provider
 * degrades to today's behavior instead of nothing. The list is how the
 * app survives RPC rate limits: the deployment points at a provider
 * first, and the public endpoint remains the safety net.
 *
 * Guarantees pinned here:
 *   - parsing trims, drops empties, and dedupes in order
 *   - a network can never inherit another network's override
 *   - the mainnet legacy single-endpoint variable still works, but only
 *     for mainnet and only until the list variable is set
 *   - RPC_ENDPOINT stays the first entry (existing consumers unchanged)
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRpcEndpoints,
  parseEndpointList,
  RPC_ENDPOINT,
  RPC_ENDPOINTS,
} from "@/lib/solana/connection";

const DEVNET_PUBLIC = "https://api.devnet.solana.com";
const MAINNET_PUBLIC = "https://api.mainnet-beta.solana.com";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseEndpointList", () => {
  it("splits on commas, trims, drops empties, and dedupes in order", () => {
    expect(
      parseEndpointList(" https://a.test , ,https://b.test,https://a.test, ")
    ).toEqual(["https://a.test", "https://b.test"]);
  });

  it("returns an empty list for missing or blank values", () => {
    expect(parseEndpointList(undefined)).toEqual([]);
    expect(parseEndpointList("")).toEqual([]);
    expect(parseEndpointList("   ")).toEqual([]);
  });
});

describe("getRpcEndpoints", () => {
  it("puts the configured provider list first and the public endpoint last", () => {
    const endpoints = getRpcEndpoints("devnet", {
      NEXT_PUBLIC_DEVNET_RPC_ENDPOINTS: "https://prov.test",
    });
    expect(endpoints).toEqual(["https://prov.test", DEVNET_PUBLIC]);
  });

  it("never lets a mainnet override reach another network", () => {
    const endpoints = getRpcEndpoints("devnet", {
      NEXT_PUBLIC_MAINNET_RPC_ENDPOINT: "https://mainnet-provider.test",
      NEXT_PUBLIC_MAINNET_RPC_ENDPOINTS: "https://mainnet-list.test",
    });
    expect(endpoints).toEqual([DEVNET_PUBLIC]);
  });

  it("mainnet falls back to the legacy single endpoint, then the public one", () => {
    const endpoints = getRpcEndpoints("mainnet-beta", {
      NEXT_PUBLIC_MAINNET_RPC_ENDPOINT: "https://legacy.test",
    });
    expect(endpoints).toEqual(["https://legacy.test", MAINNET_PUBLIC]);
  });

  it("mainnet prefers the list variable over the legacy one", () => {
    const endpoints = getRpcEndpoints("mainnet-beta", {
      NEXT_PUBLIC_MAINNET_RPC_ENDPOINTS: "https://list.test",
      NEXT_PUBLIC_MAINNET_RPC_ENDPOINT: "https://legacy.test",
    });
    expect(endpoints).toEqual(["https://list.test", "https://legacy.test", MAINNET_PUBLIC]);
  });

  it("defaults every network to its public endpoint", () => {
    expect(getRpcEndpoints("devnet", {})).toEqual([DEVNET_PUBLIC]);
    expect(getRpcEndpoints("mainnet-beta", {})).toEqual([MAINNET_PUBLIC]);
    expect(getRpcEndpoints("localhost", {})).toEqual(["http://localhost:8899"]);
    expect(getRpcEndpoints("testnet", {})).toEqual(["https://api.testnet.solana.com"]);
  });
});

describe("module-level list", () => {
  it("derives RPC_ENDPOINTS and RPC_ENDPOINT from the environment", async () => {
    vi.resetModules();
    vi.stubEnv(
      "NEXT_PUBLIC_DEVNET_RPC_ENDPOINTS",
      "https://one.test, https://two.test"
    );
    const mod = await import("@/lib/solana/connection");
    expect(mod.RPC_ENDPOINTS).toEqual([
      "https://one.test",
      "https://two.test",
      DEVNET_PUBLIC,
    ]);
    expect(mod.RPC_ENDPOINT).toBe("https://one.test");
  });

  it("keeps RPC_ENDPOINT as the first entry of the module-level list", () => {
    expect(RPC_ENDPOINT).toBe(RPC_ENDPOINTS[0]);
    expect(RPC_ENDPOINTS[RPC_ENDPOINTS.length - 1]).toBe(DEVNET_PUBLIC);
  });
});
