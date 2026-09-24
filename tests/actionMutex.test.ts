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
