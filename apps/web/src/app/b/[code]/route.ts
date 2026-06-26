export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { resolveBookingLink } from "@savvy/db";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const token = await resolveBookingLink(code);
  if (!token) {
    return new NextResponse("not found", { status: 404 });
  }
  return NextResponse.redirect(new URL(`/book/${token}`, req.url), 307);
}
