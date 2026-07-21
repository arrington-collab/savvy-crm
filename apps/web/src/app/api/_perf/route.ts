import { NextResponse } from "next/server";
import { pool } from "@savvy/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMP diagnostic (remove after the region-latency verification). Measures the
// function region and DB round-trip latency from it, to confirm/prove the
// function↔db region co-location. Gated behind a probe key so it isn't an open
// DB-hitting endpoint; returns no tenant data.
export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("k") !== "savvy-perf-probe") {
    return new NextResponse("not found", { status: 404 });
  }
  const region = process.env.VERCEL_REGION ?? "unknown";
  await pool.query("select 1"); // warm one connection (exclude TCP/TLS setup)
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await pool.query("select 1");
    samples.push(Math.round(performance.now() - t));
  }
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  return NextResponse.json({ region, dbPingMs: samples, dbPingAvgMs: avg });
}
