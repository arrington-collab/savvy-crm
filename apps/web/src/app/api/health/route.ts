import { NextResponse } from "next/server";
import { pool } from "@savvy/db";

// Liveness + DB-reachability probe. Public (in middleware PUBLIC). Uses the APP
// pool (DATABASE_URL / non-superuser savvy_app) — the same connection real
// requests use — for a trivial `SELECT 1` (needs no table grants, so RLS/grants
// don't matter). Deliberately NOT adminPool: DATABASE_ADMIN_URL isn't set on the
// deploy (migrations run manually), so probing it would give a false "db down".
// Reports the deployed commit SHA from Vercel's build-time env to confirm WHICH
// build is live.
export const dynamic = "force-dynamic";

const COMMIT_SHA =
  process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown";

export async function GET() {
  try {
    await pool.query("SELECT 1");
    return NextResponse.json({ status: "ok", db: "up", commit: COMMIT_SHA });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { status: "error", db: "down", commit: COMMIT_SHA, error: message },
      { status: 503 },
    );
  }
}
