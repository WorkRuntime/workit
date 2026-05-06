/**
 * Vitest configuration for WorkJS.
 *
 * @author Admilson B. F. Cossa
 *
 * Tests exercise the built package in `dist/` so verification proves the
 * compiled artifact, not only TypeScript source.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/*.test.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      thresholds: {
        lines: 69,
        branches: 59,
        functions: 72,
        statements: 66,
      },
    },
  },
});
