export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { resolveBookingLink } from "@savvy/db";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const link = await resolveBookingLink(code);
  if (!link) {
    return new NextResponse("not found", { status: 404 });
  }
  const path = link.kind === "status" ? `/status/${link.token}` : `/book/${link.token}`;
  return NextResponse.redirect(new URL(path, req.url), 307);
}
