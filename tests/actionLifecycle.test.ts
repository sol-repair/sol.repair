/**
 * Unit tests for the shared lifecycle machinery's domain passthrough —
 * the one type-system seam in transaction-resolution code
 * (actionLifecycle.ts, resolveTransaction's base-view extraction).
 *
 * The seam: after awaiting the hook's corroborate() closure, the
 * generic union CorroborationVerdict<D> cannot be narrowed by
 * discriminant (D is an unresolved type parameter; Awaited<D> is fully
 * opaque), so the base four are checked through an explicit base view
 * and the leftover is asserted to D. The safety argument is runtime
 * exhaustiveness, and these tests pin both halves of it:
 *
 *   1. Every base verdict maps to its shared terminal — the `as D`
 *      passthrough can never swallow a base verdict, for any D.
 *   2. A domain verdict round-trips untouched — the passthrough adds
 *      no interpretation of its own.
 *   3. Type level: for the D = never hooks, the domain verdict is
 *      `never` (uninhabitable) and the default verdict union is
 *      exactly the base four — a compile-time tripwire against anyone
 *      widening the never-hooks' union to carry domain members.
 */

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";

import {
  resolveTransaction,
  type CorroborationVerdict,
  type LifecycleResolution,
} from "../src/lib/solana/actionLifecycle";

const WINDOW = 1000;

/** A connection whose first poll is unobserved with the blockhash
 *  window provably closed — the exact state in which resolveTransaction
 *  calls corroborate(). */
function pastWindowConnection(): Connection {
  return {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => WINDOW + 1,
  } as unknown as Connection;
}

function setRunState() {
  return vi.fn();
}

describe("resolveTransaction domain passthrough (the `as D` seam)", () => {
  it("maps every base verdict to its shared terminal, never to domain", async () => {
    const cases: Array<{
      verdict: CorroborationVerdict;
      resolution: LifecycleResolution;
    }> = [
      { verdict: { type: "standard-met" }, resolution: { type: "expired-standard-met" } },
      {
        verdict: { type: "resolved", err: null },
        resolution: { type: "confirmed" },
      },
      {
        verdict: { type: "resolved", err: { InstructionError: [0, {}] } },
        resolution: { type: "on-chain-error" },
      },
      { verdict: { type: "account-gone" }, resolution: { type: "account-gone" } },
      {
        verdict: { type: "cannot-establish", detail: "the account read failed" },
        resolution: { type: "unresolved", detail: "the account read failed" },
      },
    ];
    for (const { verdict, resolution } of cases) {
      const runSetState = setRunState();
      const result = await resolveTransaction(
        pastWindowConnection(),
        "SIG",
        WINDOW,
        () => Promise.resolve(verdict),
        runSetState
      );
      expect(result).toEqual(resolution);
      expect(result.type).not.toBe("domain");
    }
  });

  it("carries a hook's domain verdict through untouched", async () => {
    type RevokeDomain =
      | { type: "delegate-absent"; read: { balance: string } }
      | { type: "delegate-changed"; current: string };
    const domainVerdict: CorroborationVerdict<RevokeDomain> = {
      type: "delegate-absent",
      read: { balance: "1000000" },
    };
    const runSetState = setRunState();
    const result = await resolveTransaction<RevokeDomain>(
      pastWindowConnection(),
      "SIG",
      WINDOW,
      () => Promise.resolve(domainVerdict),
      runSetState
    );
    expect(result).toEqual({ type: "domain", verdict: domainVerdict });
  });

  it("type level: the D = never hooks' domain verdict is uninhabitable", () => {
    // The domain member of a never-instantiated resolution carries
    // `never` — no hook code can destructure or branch on a domain
    // verdict it can never receive.
    type DomainVerdictOf<R> = R extends {
      type: "domain";
      verdict: infer V;
    } ? V
      : never;
    expectTypeOf<DomainVerdictOf<LifecycleResolution>>().toEqualTypeOf<
      never
    >();
    expectTypeOf<
      DomainVerdictOf<LifecycleResolution<{ type: "delegate-absent" }>>
    >().toEqualTypeOf<{ type: "delegate-absent" }>();
  });

  it("type level: the default verdict union is exactly the base four", () => {
    // The tripwire: if anyone widens CorroborationVerdict's default
    // (the D = never hooks' verdict space) to carry domain members,
    // this stops compiling — the invariant behind the `as D` seam.
    expectTypeOf<CorroborationVerdict>().toEqualTypeOf<
      | { type: "standard-met" }
      | { type: "resolved"; err: unknown }
      | { type: "account-gone" }
      | { type: "cannot-establish"; detail: string }
    >();
    // And a domain-shaped verdict is not a member of that space.
    expectTypeOf<{ type: "delegate-absent"; read: unknown }>().not.toExtend<
      CorroborationVerdict
    >();
  });
});
