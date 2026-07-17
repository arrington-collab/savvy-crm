import { Card } from "@/components/ui/card";
import { dueLeftoverPrompts, withTenant, job, property, materialOrder, eq, and, inArray } from "@savvy/db";
import type { MaterialOrderLine } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";
import { LeftoverCardActions } from "./LeftoverCardActions";

// Phase 26 slice 3: the manual leftover-entry card (the crew EOD photo parse
// is the upgrade path). A delivered-materials job asks ONCE: what came back?
// "Nothing" is a first-class answer — the reconciliation records it either way.
export async function LeftoverCard() {
  const tenantId = await getTenantId();
  const prompts = await dueLeftoverPrompts(tenantId).catch(() => []);
  if (prompts.length === 0) return null;

  const jobIds = prompts.map((p) => p.jobId);
  const rows = await withTenant(tenantId, async (tx) => {
    const jobs = await tx.select({ jobId: job.id, address: property.address })
      .from(job).innerJoin(property, eq(job.propertyId, property.id))
      .where(and(eq(job.tenantId, tenantId), inArray(job.id, jobIds)));
    const orders = await tx.select({ jobId: materialOrder.jobId, lineItems: materialOrder.lineItems })
      .from(materialOrder)
      .where(and(eq(materialOrder.tenantId, tenantId), inArray(materialOrder.jobId, jobIds), eq(materialOrder.status, "delivered")));
    return jobs.map((j) => ({
      ...j,
      items: orders.filter((o) => o.jobId === j.jobId)
        .flatMap((o) => (o.lineItems as MaterialOrderLine[]) ?? [])
        .map((l) => ({ key: l.key, name: l.name })),
    }));
  });

  return (
    <div className="space-y-3" data-testid="leftover-cards">
      {rows.slice(0, 3).map((r) => (
        <Card key={r.jobId} className="p-4" data-testid={`leftover-${r.jobId}`}>
          <p className="font-medium" style={{ color: "var(--text-body)" }}>
            📦 Leftover stock at {r.address}?
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            Materials were delivered for this job — count what came back so returnable stock turns into supplier
            credit instead of shrink.
          </p>
          <LeftoverCardActions jobId={r.jobId} items={r.items} />
        </Card>
      ))}
    </div>
  );
}
