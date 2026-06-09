import { NextResponse } from "next/server";
import { leadIntakeSchema, z } from "@savvy/core";
import { createLeadForTenant, tenantByKey } from "@/lib/intake";

export const runtime = "nodejs";

const bodySchema = leadIntakeSchema.extend({ key: z.string().min(1) });

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { key, ...input } = parsed.data;
  const t = await tenantByKey(key);
  if (!t) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  const leadId = await createLeadForTenant(t.id, input);
  return NextResponse.json({ leadId }, { status: 201 });
}
