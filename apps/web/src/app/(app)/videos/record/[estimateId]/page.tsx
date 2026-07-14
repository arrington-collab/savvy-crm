import { withTenant, estimate, lead, customer, eq } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { SingleTake } from "./SingleTake";

export const dynamic = "force-dynamic";

// Slice 5b: the rep's post-inspection video note — "here's what I found on
// your north slope" — recorded right after the visit, renders above the tiers.
export default async function RecordRepVideoPage({ params }: { params: Promise<{ estimateId: string }> }) {
  const { estimateId } = await params;
  const tenantId = await getTenantId();
  const name = await withTenant(tenantId, async (tx) => {
    const [est] = await tx.select({ leadId: estimate.leadId }).from(estimate).where(eq(estimate.id, estimateId));
    if (!est?.leadId) return null;
    const [l] = await tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, est.leadId));
    if (!l?.customerId) return null;
    const [c] = await tx.select({ name: customer.name }).from(customer).where(eq(customer.id, l.customerId));
    return c?.name ?? null;
  });
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Estimate" title="Video note" />
      <SingleTake estimateId={estimateId} customerName={name ?? "the homeowner"} />
    </div>
  );
}
