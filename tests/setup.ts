/**
 * Vitest setup file, run before every test file.
 *
 * The jsdom environment replaces the typed-array globals with jsdom's own
 * realm copies. Node's Buffer instances then fail `instanceof Uint8Array`
 * checks inside @solana/web3.js and @solana/buffer-layout (throwing
 * "b must be a Uint8Array"), which breaks transaction building and signing
 * in jsdom-based tests. Restore node's constructor; jsdom keeps its own
 * realm copies internally, so this only affects code running in the test
 * realm. No-op in the default node environment.
 */
import { Buffer as NodeBuffer } from "node:buffer";

const nodeUint8Array = Object.getPrototypeOf(NodeBuffer.prototype)
  ?.constructor as typeof Uint8Array | undefined;

if (nodeUint8Array && globalThis.Uint8Array !== nodeUint8Array) {
  globalThis.Uint8Array = nodeUint8Array;
}
