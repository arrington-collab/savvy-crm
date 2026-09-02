import type { NextConfig } from "next";

// Knock Jockey's field API — the canvass routes, deployed on their own so a
// roofing-CRM deploy can never take down knock sync (and vice versa). Same
// database and session secret as savvy-crm's copy of these routes; no Clerk,
// no middleware — canvass auth is entirely bearer-token.
const nextConfig: NextConfig = {
  transpilePackages: ["@savvy/db", "@savvy/agents", "@savvy/ai", "@savvy/core", "@savvy/integrations"],
};

export default nextConfig;
