import { NextRequest, NextResponse } from "next/server";
import { parseActivityQuery } from "@savvy/core";
import { loadActivityPage } from "@/lib/command-center-queries";

// Poll endpoint for the activity feed — always tenant-scoped, read-only, no caching.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const opts = parseActivityQuery((k) => req.nextUrl.searchParams.get(k));
  const data = await loadActivityPage(opts);
  return NextResponse.json(data);
}
