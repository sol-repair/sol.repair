/**
 * Synchronous, app-wide mutual exclusion between the two wallet action
 * flows — the empty-account repair and the G.2 delegate revocation
 * (spec §8.12).
 *
 * Why a module-scoped lock and not per-hook state: each action hook
 * already guards its own re-entry with a synchronous ref (set before
 * the first await), but two separate hooks cannot see each other's
 * refs. This lock is acquired by BOTH hooks immediately after their
 * local ref guard, synchronously — before any await — so two actions
 * initiated in the same tick cannot both start: JavaScript runs each
 * action's entry up to its first await without interleaving, and the
 * second acquire sees the hold. Disabling buttons remains, but only
 * as an affordance; correctness comes from this acquire.
 *
 * Release is never timer-based (spec §8.12). Terminals whose
 * transactions can no longer land release automatically in the
 * action's `finally`; the one terminal that may still be in flight
 * (`unverified / unresolved-outcome`) holds the lock until the user
 * explicitly dismisses it — the hook calls releaseAction on that
 * dismissal. `releaseAction` refuses to release a hold owned by the
 * other kind, so a bug in one hook cannot free the other's lock.
 *
 * Scope is the page instance: reloading the page abandons all
 * in-flight state and nothing auto-acts afterwards — the same
 * property the repair flow has always had. Cross-flow safety after a
 * release does not depend on the lock: the two flows' account sets
 * are provably disjoint (close requires balance 0, revoke requires a
 * positive balance).
 *
 * Pure TypeScript, no imports: Layer 0 under src/lib/ because it is
 * not Solana-specific and must be trivially unit-testable.
 */

export type ActionKind = "repair" | "revoke";

let held: ActionKind | null = null;

/**
 * Try to take the lock for `kind`. Returns false — and changes
 * nothing — when any action currently holds it. Synchronous by
 * contract: callers must invoke this before their first await.
 */
export function acquireAction(kind: ActionKind): boolean {
  if (held !== null) return false;
  held = kind;
  return true;
}

/**
 * Release the lock. Only the kind that owns the hold can release it;
 * a release from the other kind is a no-op.
 */
export function releaseAction(kind: ActionKind): void {
  if (held === kind) held = null;
}

/** The currently holding kind, or null when no action is in flight. */
export function heldAction(): ActionKind | null {
  return held;
}
