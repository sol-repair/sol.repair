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
    // The default forks pool timed out starting jsdom workers on Windows;
    // threads start reliably here.
    pool: "threads",
    setupFiles: ["./tests/setup.ts"],
  },
});
