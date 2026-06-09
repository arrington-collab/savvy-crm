import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false, // DB tests share one schema; run serially
    hookTimeout: 30000,
  },
});
