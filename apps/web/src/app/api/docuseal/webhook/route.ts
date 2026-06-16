import { NextResponse } from "next/server";
import { adminDb, estimate, eq } from "@savvy/db";
import { httpDocuseal } from "@savvy/integrations";
import { inngest } from "@savvy/agents";

// DocuSeal posts submission lifecycle events here. On `form.completed` we resolve
// the tenant from the estimate matched by submissionId (adminDb — RLS root) and
// emit estimate/accepted, which advances the job to approved.
export async function POST(req: Request) {
  const payload = await req.json().catch(() => null);
  const ev = httpDocuseal.parseEvent(payload);
  if (!ev || ev.status !== "completed") return NextResponse.json({ ok: true });

  const [est] = await adminDb
    .select()
    .from(estimate)
    .where(eq(estimate.docusealSubmissionId, ev.submissionId));
  if (!est) return NextResponse.json({ ok: true });

  try {
    await inngest.send({ name: "estimate/accepted", data: { tenantId: est.tenantId, estimateId: est.id } });
  } catch (e) {
    console.error(e);
  }
  return NextResponse.json({ ok: true });
}
