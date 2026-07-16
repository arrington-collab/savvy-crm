import Link from "next/link";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { withTenant, certRequest, partner, property, user, eq, and, isNull } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { CertsClient } from "./CertsClient";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

// Partner Ledger slice 4 — the paid cert lane's office console. Requests are
// created here; booking uses the existing appointment machinery (priority
// partners are labeled — slack-capacity is the default class); delivery is
// AUTOMATIC once the inspector approves. Red age = the 48h SLA is at risk.
export default async function CertsPage() {
  const tenantId = await getTenantId();
  const [rows, reps] = await Promise.all([
    withTenant(tenantId, (tx) =>
      tx.select({
        id: certRequest.id,
        status: certRequest.status,
        priceCents: certRequest.priceCents,
        requestedAt: certRequest.requestedAt,
        deliveredAt: certRequest.deliveredAt,
        declineReason: certRequest.declineReason,
        certCode: certRequest.certCode,
        address: property.address,
        partnerName: partner.name,
        partnerOrg: partner.org,
        priority: partner.schedulingPriority,
      }).from(certRequest)
        .innerJoin(property, eq(certRequest.propertyId, property.id))
        .innerJoin(partner, eq(certRequest.partnerId, partner.id))
        .where(eq(certRequest.tenantId, tenantId))
        .orderBy(certRequest.requestedAt),
    ),
    withTenant(tenantId, (tx) =>
      tx.select({ id: user.id, name: user.name }).from(user)
        .where(and(eq(user.tenantId, tenantId), isNull(user.deactivatedAt))),
    ),
  ]);

  return (
    <div className="space-y-5" data-testid="certs-page">
      <PageHeader eyebrow="Partners · Paid cert lane" title="Roof certs" />
      <div className="flex items-center justify-between">
        <p className="max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
          Pre-sale roof certifications for partner transactions. Booked through normal scheduling
          (priority partners flagged), delivered automatically when the inspection is approved —
          every request must reach <b>delivered or declined within 48 hours</b>.
        </p>
        <Link href="/partners" className="mono shrink-0 text-[12px] underline" style={{ color: "var(--accent-deep)" }}>
          ← Partner Ledger
        </Link>
      </div>
      <CertsClient
        rows={rows.map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString(), deliveredAt: r.deliveredAt?.toISOString() ?? null }))}
        reps={reps}
      />
    </div>
  );
}
