import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Lets a second `next dev` (the e2e demo-tenant server on :3001) build into its
  // own dist dir so two concurrent dev servers on this same project don't clash on
  // `.next`. Defaults to Next's standard `.next` for every normal run/build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  transpilePackages: [
    "@savvy/db",
    "@savvy/agents",
    "@savvy/ai",
    "@savvy/core",
    "@savvy/integrations",
    "@savvy/ui",
  ],
};

export default withSentryConfig(nextConfig, {
  // Source-map upload disabled for now (no SENTRY_AUTH_TOKEN) — deferred polish.
  silent: !process.env.CI,
});
