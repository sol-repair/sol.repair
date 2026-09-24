/**
 * Unit tests for the G.2 action mutex (spec §8.12, §10.2.11): the
 * synchronous, app-wide lock that makes the repair flow and the
 * delegate-revocation flow mutually exclusive at initiation time.
 */

import { describe, expect, it } from "vitest";

import {
  acquireAction,
  heldAction,
  releaseAction,
} from "../src/lib/actionMutex";

describe("actionMutex", () => {
  it("an uncontended acquire succeeds", () => {
    expect(acquireAction("revoke")).toBe(true);
    releaseAction("revoke");
  });

  it("a second acquire of any kind is refused while held", () => {
    expect(acquireAction("repair")).toBe(true);
    expect(acquireAction("revoke")).toBe(false);
    expect(acquireAction("repair")).toBe(false);
    releaseAction("repair");
  });

  it("release clears the hold", () => {
    acquireAction("revoke");
    releaseAction("revoke");
    expect(heldAction()).toBeNull();
  });

  it("a release with the wrong kind leaves the hold intact", () => {
    acquireAction("revoke");
    releaseAction("repair");
    expect(heldAction()).toBe("revoke");
    releaseAction("revoke");
    expect(heldAction()).toBeNull();
  });

  it("heldAction reports the holder", () => {
    acquireAction("repair");
    expect(heldAction()).toBe("repair");
    releaseAction("repair");
    expect(heldAction()).toBeNull();
  });

  it("re-acquire after release succeeds", () => {
    expect(acquireAction("revoke")).toBe(true);
    releaseAction("revoke");
    expect(acquireAction("repair")).toBe(true);
    releaseAction("repair");
  });
});

describe("actionMutex: the unwrap kind (G.3 §10.2.10, additive)", () => {
  it('"unwrap" acquires an uncontended lock', () => {
    expect(acquireAction("unwrap")).toBe(true);
    expect(heldAction()).toBe("unwrap");
    releaseAction("unwrap");
    expect(heldAction()).toBeNull();
  });

  it('"unwrap" is refused while either existing kind holds', () => {
    expect(acquireAction("repair")).toBe(true);
    expect(acquireAction("unwrap")).toBe(false);
    expect(heldAction()).toBe("repair");
    releaseAction("repair");

    expect(acquireAction("revoke")).toBe(true);
    expect(acquireAction("unwrap")).toBe(false);
    expect(heldAction()).toBe("revoke");
    releaseAction("revoke");
  });

  it('a hold by "unwrap" refuses both existing kinds', () => {
    expect(acquireAction("unwrap")).toBe(true);
    expect(acquireAction("repair")).toBe(false);
    expect(acquireAction("revoke")).toBe(false);
    releaseAction("unwrap");
  });

  it('a wrong-kind release leaves an "unwrap" hold intact', () => {
    acquireAction("unwrap");
    releaseAction("repair");
    expect(heldAction()).toBe("unwrap");
    releaseAction("revoke");
    expect(heldAction()).toBe("unwrap");
    releaseAction("unwrap");
    expect(heldAction()).toBeNull();
  });

  it("re-acquire after an unwrap release succeeds for the other kinds", () => {
    expect(acquireAction("unwrap")).toBe(true);
    releaseAction("unwrap");
    expect(acquireAction("revoke")).toBe(true);
    releaseAction("revoke");
    expect(acquireAction("unwrap")).toBe(true);
    releaseAction("unwrap");
  });
});
