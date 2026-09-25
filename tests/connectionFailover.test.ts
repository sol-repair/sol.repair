/**
 * M9 per-call failover tests (src/lib/solana/rpc.ts): rotation on
 * transport-shaped errors, immediate rethrow on everything else, the
 * last-error guarantee, and non-function passthrough. The connection
 * factory is injected, so no network and no web3.js internals.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFailoverConnection,
  wrapWithFailover,
} from "../src/lib/solana/rpc";

const ENDPOINTS = ["https://primary.example", "https://secondary.example", "https://fallback.example"];

/** A fake connection: methods are scripted as (status | Error) sequences
 *  exactly like the sendAndConfirm-style scripts elsewhere — a number
 *  resolves, an Error rejects. */
function fakeConnection(script: Record<string, (number | Error)[]>) {
  const calls: Record<string, number> = {};
  const connection = {
    endpoint: "fake://connection",
    commitment: "confirmed",
  };
  for (const [method, queue] of Object.entries(script)) {
    const q = [...queue];
    calls[method] = 0;
    (connection as Record<string, unknown>)[method] = vi.fn(async () => {
      calls[method] += 1;
      const next = q.shift();
      if (next === undefined) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return { status: next, ok: next < 400 };
    });
  }
  return { connection, calls };
}

const make429 = () => new Error("429 Too Many Requests: {\"code\":-32005,\"message\":\"Too many requests\"}");
const makeFailed = () => new Error("fetch failed");
const makeOnChain = () => new Error("invalid account data");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFailoverConnection (M9)", () => {
  it("returns the primary's answer without rotating", async () => {
    const { connection, calls } = fakeConnection({
      getBalance: [200],
    });
    const conn = createFailoverConnection(ENDPOINTS, () => connection as never);
    const res = await (conn as unknown as {
      getBalance: () => Promise<{ status: number }>;
    }).getBalance();
    expect(res.status).toBe(200);
    expect(calls.getBalance).toBe(1);
  });

  it("rotates to the next endpoint on a 429 and returns its answer", async () => {
    const primary = fakeConnection({ getBalance: [make429()] });
    const secondary = fakeConnection({ getBalance: [200] });
    const made: string[] = [];
    const conn = createFailoverConnection(ENDPOINTS, (endpoint) => {
      made.push(endpoint);
      return (endpoint === ENDPOINTS[0] ? primary : secondary).connection as never;
    });
    const res = (await (conn as never as { getBalance: () => { status: number } }).getBalance()) as { status: number };
    expect(res.status).toBe(200);
    expect(made).toEqual(ENDPOINTS);
    expect(primary.calls.getBalance).toBe(1);
    expect(secondary.calls.getBalance).toBe(1);
  });

  it("rotates through two failing endpoints before succeeding", async () => {
    const first = fakeConnection({ getLatestBlockhash: [makeFailed()] });
    const second = fakeConnection({ getLatestBlockhash: [make429()] });
    const third = fakeConnection({ getLatestBlockhash: [200] });
    const conn = createFailoverConnection(ENDPOINTS, (endpoint) =>
      (endpoint === ENDPOINTS[0] ? first : endpoint === ENDPOINTS[1] ? second : third)
        .connection as never
    );
    const res = (await (conn as never as { getLatestBlockhash: () => { status: number } }).getLatestBlockhash()) as { status: number };
    expect(res.status).toBe(200);
    expect(third.calls.getLatestBlockhash).toBe(1);
  });

  it("an on-chain (non-transport) error rethrows immediately — no rotation", async () => {
    const primary = fakeConnection({ getAccountInfo: [makeOnChain()] });
    const secondary = fakeConnection({ getAccountInfo: [200] });
    const conn = createFailoverConnection(ENDPOINTS, (endpoint) =>
      (endpoint === ENDPOINTS[0] ? primary : secondary).connection as never
    );
    await expect(
      (conn as never as { getAccountInfo: () => unknown }).getAccountInfo()
    ).rejects.toThrow("invalid account data");
    expect(secondary.calls.getAccountInfo).toBe(0);
  });

  it("when every endpoint fails, the LAST transport error is rethrown", async () => {
    const a = fakeConnection({ getEpochInfo: [make429()] });
    const b = fakeConnection({ getEpochInfo: [makeFailed()] });
    const c = fakeConnection({ getEpochInfo: [make429()] });
    const conn = createFailoverConnection(ENDPOINTS, (endpoint) =>
      (endpoint === ENDPOINTS[0] ? a : endpoint === ENDPOINTS[1] ? b : c).connection as never
    );
    await expect(
      (conn as never as { getEpochInfo: () => unknown }).getEpochInfo()
    ).rejects.toThrow("Too many requests");
  });

  it("non-function properties pass through to the primary", () => {
    const primary = fakeConnection({});
    const conn = createFailoverConnection(ENDPOINTS, () => primary.connection as never);
    expect((conn as never as { endpoint: string }).endpoint).toBe("fake://connection");
    expect((conn as never as { commitment: string }).commitment).toBe("confirmed");
  });

  it("an empty endpoint list is a construction error", () => {
    expect(() => createFailoverConnection([], () => fakeConnection({}).connection as never)).toThrow(
      "empty endpoint list"
    );
  });
});

describe("wrapWithFailover", () => {
  it("returns the primary untouched when fewer than two endpoints are configured", () => {
    const primary = fakeConnection({ getBalance: [make429()] });
    const conn = wrapWithFailover(
      primary.connection as never,
      ENDPOINTS[0],
      [ENDPOINTS[0]]
    );
    expect(conn).toBe(primary.connection);
  });

  it("wraps the primary with failover across the remaining endpoints", async () => {
    const primary = fakeConnection({ getBalance: [make429()] });
    const secondary = fakeConnection({ getBalance: [200] });
    const made: string[] = [];
    const conn = wrapWithFailover(
      primary.connection as never,
      ENDPOINTS[0],
      ENDPOINTS,
      (endpoint) => {
        made.push(endpoint);
        return (endpoint === ENDPOINTS[0] ? primary : secondary).connection as never;
      }
    );
    const res = (await (conn as never as { getBalance: () => { status: number } }).getBalance()) as { status: number };
    expect(res.status).toBe(200);
    // The primary is target #1; the remaining configured endpoints follow.
    expect(made).toEqual(ENDPOINTS.slice(1));
    expect(secondary.calls.getBalance).toBe(1);
  });
});
