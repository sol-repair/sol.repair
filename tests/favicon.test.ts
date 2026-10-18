// @vitest-environment node

/**
 * Pin for the favicon.ico fallback. Browsers that never request SVG
 * icons (and many crawlers) ask for /favicon.ico first; on the live
 * site that path 404'd while src/app/icon.svg served 200. Next serves
 * src/app/favicon.ico at /favicon.ico automatically (the favicon file
 * convention only allows the app root), so the pin is fs-based, in the
 * same spirit as the routePaths helper in sitemapRobots.test.ts: the
 * file exists and starts with a valid ICO header.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FAVICON = path.resolve(__dirname, "../src/app/favicon.ico");

/** ICO files start with a reserved word (0), a type word (1 = icon), and a count word. */
function icoEntries(buf: Buffer): { width: number; height: number }[] {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error("not an ICO file");
  }
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    // A 0 in the width/height bytes means 256; every real size is stored as-is.
    entries.push({
      width: buf.readUInt8(at) === 0 ? 256 : buf.readUInt8(at),
      height: buf.readUInt8(at + 1) === 0 ? 256 : buf.readUInt8(at + 1),
    });
  }
  return entries;
}

describe("the favicon.ico fallback", () => {
  it("exists at src/app/favicon.ico with a valid ICO header (00 00 01 00)", () => {
    const buf = fs.readFileSync(FAVICON);
    expect(buf.length).toBeGreaterThan(0);
    expect([...buf.subarray(0, 4)]).toEqual([0x00, 0x00, 0x01, 0x00]);
  });

  it("packs the 16px and 32px renders of the icon design", () => {
    const entries = icoEntries(fs.readFileSync(FAVICON));
    expect(entries).toEqual([
      { width: 16, height: 16 },
      { width: 32, height: 32 },
    ]);
  });
});
