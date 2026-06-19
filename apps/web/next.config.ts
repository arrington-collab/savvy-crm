import type { NextConfig } from "next";

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

export default nextConfig;
