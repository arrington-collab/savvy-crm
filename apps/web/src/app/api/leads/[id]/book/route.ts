import { NextResponse } from "next/server";
import { inngest } from "@savvy/agents";
import { adminDb, lead, eq } from "@savvy/db";

export const runtime = "nodejs";

// GET so the SMS link is clickable. Books an inspection ~1 day out (demo) by
// emitting lead/booked; the leadBooked workflow creates the appointment + job.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [l] = await adminDb.select().from(lead).where(eq(lead.id, id));
  if (!l) return NextResponse.json({ error: "not found" }, { status: 404 });
  const startsAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  await inngest.send({ name: "lead/booked", data: { leadId: id, tenantId: l.tenantId, startsAt } });
  return NextResponse.json({ booked: true, startsAt });
}
