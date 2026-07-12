import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const PUBLIC = [/^\/$/, /^\/api\/health$/, /^\/intake\//, /^\/crew\//, /^\/api\/leads$/, /^\/api\/canvass\/(login|contract|reps|knocks|eod|territories|dossier|geocode|storms|certificate|company)$/, /^\/api\/twilio\//, /^\/api\/inngest$/, /^\/api\/stripe\/webhook$/, /^\/api\/docuseal\/webhook$/, /^\/api\/companycam\/webhook$/, /^\/api\/clerk\/webhook$/, /^\/api\/voice\/vapi$/, /^\/sign-in/, /^\/sign-up/, /^\/select-org$/, /^\/b\//, /^\/book\//, /^\/status\//];

export default process.env.TEST_MODE === "1"
  ? () => NextResponse.next() // e2e bypass: no Clerk, getTenantId() uses TEST_TENANT_ID
  : clerkMiddleware(async (auth, req) => {
      const path = req.nextUrl.pathname;
      if (PUBLIC.some((re) => re.test(path))) return;
      await auth.protect();
    });

export const config = { matcher: ["/((?!_next|.*\\..*).*)", "/api/(.*)"] };
