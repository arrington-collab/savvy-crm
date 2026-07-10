import { NextResponse } from "next/server";
import { leadIntakeObject, hasContactMethod, contactMethodIssue, leadSourceDetailSchema, z } from "@savvy/core";
import { createLeadForTenant, tenantByKey } from "@/lib/intake";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { log } from "@/lib/log";

export const runtime = "nodejs";

const bodySchema = leadIntakeObject
  .extend({ key: z.string().min(1) })
  .refine(hasContactMethod, contactMethodIssue)
  .refine(
    (d) => leadSourceDetailSchema(d.source).safeParse(d.sourceDetail ?? (d.source === "other" ? {} : null)).success,
    { message: "Fill in the required details for this source", path: ["sourceDetail"] },
  );

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { key, ...input } = parsed.data;
  const ip = clientIp(req.headers);
  const { ok } = await checkRateLimit("leads", `${key}:${ip}`);
  if (!ok) {
    log.warn("lead intake rate limited", { route: "/api/leads", tenantKey: key });
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const t = await tenantByKey(key);
  if (!t) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  const leadId = await createLeadForTenant(t.id, input);
  log.info("lead intake accepted", { route: "/api/leads", tenantId: t.id });
  return NextResponse.json({ leadId }, { status: 201 });
}
