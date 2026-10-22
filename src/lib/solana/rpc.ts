/**
 * M9 per-call failover (owner-approved): the app's RPC transport with
 * rotation across the ordered endpoint list from connection.ts.
 *
 * Rotation rules:
 *   - A call that THROWS with a transport-shaped error (HTTP 429 quota,
 *     rate limit, fetch failed, connection refused, timeout) is retried
 *     on the next endpoint's Connection. Each attempt is exactly one
 *     real request — no probe-then-fetch doubling.
 *   - Any error that does NOT match a transport shape rethrows
 *     immediately: on-chain failures and chain-state errors (blockhash
 *     expiry, account not found) would be identical on every endpoint,
 *     so rotating cannot help.
 *   - When the last endpoint also fails, the last error is rethrown
 *     unchanged, so the app's existing honest failure copy and retry
 *     machinery behave exactly as on a single-endpoint setup.
 *
 * Activation rule: failover exists only when the endpoint list provides
 * MORE THAN ONE endpoint. A single-endpoint deployment (or a test run,
 * where no provider list is configured) gets its connection returned
 * untouched — nothing to rotate to, no behavior change.
 *
 * What M9 deliberately does NOT fix: an endpoint that ACCEPTS a submit
 * (returns a signature) and then silently drops it. That failure mode
 * produces no thrown error to rotate on; it is handled by each action's
 * own evidence-driven confirmation loop, not by the transport.
 */

import { Connection } from "@solana/web3.js";

/** Transport-shaped failures that justify rotating to the next
 *  endpoint. Identification is structural, never a bare digit that
 *  could sit inside a base58 identifier or a slot number: a status
 *  code read from the error object where the SDK exposes one, a
 *  status code LEADING the message exactly as web3.js formats HTTP
 *  failures ("429 Too Many Requests: ...", including the empty-body
 *  "429 : " shape), or multi-word wordings. */
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

const TRANSIENT_RPC_ERROR = /too many requests|rate limit|fetch failed|failed to fetch|networkerror|network error|econnrefused|socket hang up|timed out|timeout|internal server error|bad gateway|service unavailable/i;

function isTransientRpcError(error: unknown): boolean {
  // JSON-RPC channel: web3.js attaches the numeric error code to
  // SolanaJSONRPCError. -32005 is the node-unhealthy/rate-limited class.
  if (typeof error === "object" && error !== null && "code" in error) {
    if ((error as { code?: unknown }).code === -32005) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  // HTTP channel: web3.js throws a plain Error for a non-OK response,
  // its message starting with the numeric status followed by a space
  // or colon. Anchored at the start, so a signature or address carrying
  // the same digits can never match.
  const leadingStatus = /^(\d{3})[\s:]/.exec(message);
  if (
    leadingStatus !== null &&
    TRANSIENT_HTTP_STATUSES.has(Number(leadingStatus[1]))
  ) {
    return true;
  }
  return TRANSIENT_RPC_ERROR.test(message);
}

/** A connection factory: endpoint URL to a Connection. Injectable so
 *  tests never touch the network. */
export type ConnectionFactory = (endpoint: string) => Connection;

function proxyOver(connections: Connection[]): Connection {
  return new Proxy(connections[0], {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        let lastError: unknown = null;
        for (const connection of connections) {
          try {
            const method = Reflect.get(connection, property, connection) as (
              ...a: unknown[]
            ) => unknown;
            return await method.apply(connection, args);
          } catch (error) {
            if (!isTransientRpcError(error)) {
              throw error;
            }
            lastError = error;
          }
        }
        throw lastError;
      };
    },
  }) as Connection;
}

/**
 * Build a failover Connection over the ordered endpoint list.
 *
 * @param endpoints   ordered endpoints, primary first
 * @param make        connection factory, injectable for tests
 */
export function createFailoverConnection(
  endpoints: string[],
  make: ConnectionFactory = (endpoint) =>
    new Connection(endpoint, "confirmed")
): Connection {
  const connections = endpoints.map(make);
  if (connections.length === 0) {
    throw new Error("createFailoverConnection: empty endpoint list");
  }
  return proxyOver(connections);
}

/**
 * Wrap the wallet-adapter's primary connection with failover across the
 * REMAINING configured endpoints (the primary is always tried first, so
 * it is dropped from the rotation targets). With fewer than two
 * configured endpoints there is nothing to rotate to and the primary is
 * returned untouched — which also makes every test that injects a
 * connection through the adapter mock fully hermetic.
 */
export function wrapWithFailover(
  primary: Connection,
  primaryEndpoint: string,
  endpoints: string[],
  make: ConnectionFactory = (endpoint) =>
    new Connection(endpoint, "confirmed")
): Connection {
  if (endpoints.length < 2) return primary;
  const rest = endpoints.filter((endpoint) => endpoint !== primaryEndpoint);
  if (rest.length === 0) return primary;
  return proxyOver([primary, ...rest.map(make)]);
}
