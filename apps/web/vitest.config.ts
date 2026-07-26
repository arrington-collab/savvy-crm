import path from "node:path";
import { defineConfig } from "vitest/config";

// apps/web has BOTH vitest unit/integration tests (src/**/*.test.ts) and
// Playwright e2e specs (tests/e2e/**/*.spec.ts). The root vitest.workspace.ts
// deliberately excludes apps/* so `pnpm test` (root) never touches this
// package — this config exists only for `pnpm --filter @savvy/web test`,
// and must exclude tests/e2e/** so vitest doesn't try to run Playwright
// specs (which match its default *.spec.ts glob) through the vitest runner.
export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
