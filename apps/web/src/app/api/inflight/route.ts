import { NextResponse } from "next/server";
import { loadInflight } from "@/lib/inflight-queries";

// Poll endpoint for the in-flight dots — always tenant-scoped, read-only, no caching.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await loadInflight());
}
