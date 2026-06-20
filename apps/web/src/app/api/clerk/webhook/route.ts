import { NextResponse } from "next/server";
import { adminDb, tenant, ensureTenantForOrg, ensureUser, deactivateUserByClerkId, eq } from "@savvy/db";
import { clerkClient } from "@clerk/nextjs/server";
import { mapClerkRole } from "@savvy/core";
import { verifySvix } from "@/lib/svix";
import { log } from "@/lib/log";

export const runtime = "nodejs"; // node:crypto for HMAC

type ClerkEvent = { type?: string; data?: Record<string, unknown> };
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

async function tenantIdForOrg(orgId: string): Promise<string | null> {
  const [t] = await adminDb.select({ id: tenant.id }).from(tenant).where(eq(tenant.clerkOrgId, orgId));
  return t?.id ?? null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();
  const ok = verifySvix(
    raw,
    { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") },
    process.env.CLERK_WEBHOOK_SECRET ?? "",
  );
  if (!ok) return new NextResponse("bad signature", { status: 401 });

  let evt: ClerkEvent;
  try { evt = JSON.parse(raw) as ClerkEvent; } catch { return new NextResponse("bad payload", { status: 400 }); }
  const data = (evt.data ?? {}) as Record<string, unknown>;
  log.info("clerk webhook received", { route: "/api/clerk/webhook", event: evt.type ?? "unknown" });

  if (evt.type === "organization.created") {
    const orgId = str(data.id);
    if (!orgId) return NextResponse.json({ ok: true });
    const { id: tenantId } = await ensureTenantForOrg({ clerkOrgId: orgId, name: str(data.name) ?? "Workspace" });
    const createdBy = str(data.created_by);
    if (createdBy) {
      const cc = await clerkClient();
      const cu = await cc.users.getUser(createdBy);
      const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId) ?? cu.emailAddresses[0];
      const name = [cu.firstName, cu.lastName].filter(Boolean).join(" ") || cu.username || "Owner";
      await ensureUser({ tenantId, clerkUserId: createdBy, name, email: primary?.emailAddress ?? "", role: "owner" });
    }
    return NextResponse.json({ ok: true });
  }

  if (evt.type === "organizationMembership.created" || evt.type === "organizationMembership.updated") {
    const orgObj = (data.organization ?? {}) as Record<string, unknown>;
    const pud = (data.public_user_data ?? {}) as Record<string, unknown>;
    const orgId = str(orgObj.id);
    const cuid = str(pud.user_id);
    if (!orgId || !cuid) return NextResponse.json({ ok: true });
    const tenantId = await tenantIdForOrg(orgId);
    if (!tenantId) return NextResponse.json({ ok: true });
    const cc = await clerkClient();
    const org = await cc.organizations.getOrganization({ organizationId: orgId });
    const name = [str(pud.first_name), str(pud.last_name)].filter(Boolean).join(" ") || str(pud.identifier) || "Member";
    const role = mapClerkRole(str(data.role), org.createdBy === cuid);
    await ensureUser({ tenantId, clerkUserId: cuid, name, email: str(pud.identifier) ?? "", role });
    return NextResponse.json({ ok: true });
  }

  if (evt.type === "organizationMembership.deleted") {
    const orgObj = (data.organization ?? {}) as Record<string, unknown>;
    const pud = (data.public_user_data ?? {}) as Record<string, unknown>;
    const orgId = str(orgObj.id);
    const cuid = str(pud.user_id);
    if (orgId && cuid) {
      const tenantId = await tenantIdForOrg(orgId);
      if (tenantId) await deactivateUserByClerkId({ tenantId, clerkUserId: cuid });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
