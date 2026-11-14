import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest config. Node environment by default; React tests opt into jsdom
 * per file with a @vitest-environment pragma. The only global changes are
 * the @/ path alias (so tests import the same way the app does) and the
 * setup file that fixes the jsdom typed-array realm mismatch.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // CONFIG-ONLY GATE FIX (owner directive 2026-11-14): the threads
    // pool hung at WORKER TERMINATION ("Timeout terminating threads
    // worker"; the CI gate failed three consecutive runs, always on the
    // same file, which itself completed in 143ms - a CPU profile shows
    // the main thread idle at the terminate wait). The code audit found
    // no leak in the feature files, and a sequential run over the
    // heaviest page tests exits cleanly with no resident process, so
    // the hang is worker infrastructure, not the feature. Forks is the
    // deterministic pool: worker termination is a process kill, not a
    // cooperative thread drain. With sequential file execution the
    // old Windows forks startup race is gone too. The gate is slower
    // (~10 minutes) and deterministic. No tests were skipped, weakened,
    // or timed out.
    pool: "forks",
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
  },
});
