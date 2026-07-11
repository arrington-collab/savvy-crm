import { defineConfig } from "vitest/config";
import path from "node:path";

// Server-side lib tests import files that start with `import "server-only"`
// (Next.js's guard against accidentally bundling server code into the client).
// Next's own bundler aliases that specifier to an empty module on the server
// side; vitest doesn't know about that alias, so we mirror it here — same
// empty module Next uses — plus the `@/` path alias apps/web code relies on.
export default defineConfig({
  resolve: {
    alias: {
      "server-only": require.resolve("server-only").replace(/index\.js$/, "empty.js"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
