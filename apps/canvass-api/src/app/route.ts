import { NextResponse } from "next/server";

// Root ping — lets a human (or the sentinel) see the service is alive.
export function GET(): NextResponse {
  return NextResponse.json({ ok: true, service: "knockjockey-api" });
}
