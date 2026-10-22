import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

/**
 * The headers next.config stamps onto every standard route response,
 * read from the /:path* source block as a key/value map.
 */
async function routeHeaders(): Promise<Record<string, string>> {
  const headersFn = nextConfig.headers;
  if (!headersFn) {
    throw new Error("next.config defines no headers() function");
  }
  const entries = await headersFn();
  const baseline = entries.find((entry) => entry.source === "/:path*");
  if (!baseline) {
    throw new Error("the /:path* header block is missing from next.config");
  }
  return Object.fromEntries(baseline.headers.map((h) => [h.key, h.value]));
}

describe("next.config security headers on standard routes", () => {
  it("isolates the browsing context with Cross-Origin-Opener-Policy: same-origin", async () => {
    const headers = await routeHeaders();
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });

  it("pins Strict-Transport-Security with the two-year max-age and the subdomain flag", async () => {
    const headers = await routeHeaders();
    expect(headers["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
  });
});
