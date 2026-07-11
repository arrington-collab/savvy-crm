import { NextRequest, NextResponse } from "next/server";
import { loadActivityPage } from "@/lib/command-center-queries";

// Poll endpoint for the activity feed — always tenant-scoped, read-only, no caching.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const beforeRaw = p.get("before");
  const data = await loadActivityPage({
    limit: p.get("limit") ? Number(p.get("limit")) : 30,
    before: beforeRaw ? new Date(beforeRaw) : undefined,
    agent: p.get("agent") ?? undefined,
    status: p.get("status") ?? undefined,
    jobId: p.get("job") ?? undefined,
  });
  return NextResponse.json(data);
}
