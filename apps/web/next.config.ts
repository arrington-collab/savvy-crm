import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
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
