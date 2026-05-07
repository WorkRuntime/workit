/**
 * Vitest configuration for WorkJS.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
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
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
