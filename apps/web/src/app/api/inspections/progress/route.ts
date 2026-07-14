import { NextRequest, NextResponse } from "next/server";
import { getActiveInspectionForLead } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";

// Poll endpoint for the live inspection card — tenant-scoped, read-only.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const leadId = req.nextUrl.searchParams.get("leadId");
  if (!leadId) return NextResponse.json({ error: "missing_lead" }, { status: 400 });
  const tenantId = await getTenantId();
  const progress = await getActiveInspectionForLead({ tenantId, leadId });
  return NextResponse.json({ progress });
}
