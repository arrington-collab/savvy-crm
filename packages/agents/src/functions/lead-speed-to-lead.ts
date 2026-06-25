import { adminDb, withTenant, lead, tenant, eq, getAssignmentCandidates, setLeadOwner, recordAgentRun } from "@savvy/db";
import { parseSpeedToLeadConfig, pickReassignee } from "@savvy/core";
import { inngest } from "../client";

async function loadSla(tenantId: string): Promise<{ firstTouchSlaMin: number; escalateMin: number }> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  return parseSpeedToLeadConfig((t?.settings as { speedToLead?: unknown } | null)?.speedToLead);
}

export const leadSpeedToLead = inngest.createFunction(
  { id: "lead-speed-to-lead", concurrency: { limit: 10 }, cancelOn: [{ event: "lead/contacted", match: "data.leadId" }] },
  { event: "lead/created" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;
    const cfg = await step.run("load-sla", () => loadSla(tenantId));

    await step.sleep("first-touch-sla", `${cfg.firstTouchSlaMin}m`);
    const overdue = await step.run("check-overdue", async () =>
      withTenant(tenantId, async (tx) => {
        const [l] = await tx.select({ contacted: lead.firstRepContactAt, owner: lead.assignedUserId }).from(lead).where(eq(lead.id, leadId));
        return l && l.contacted == null && l.owner != null ? { owner: l.owner } : null;
      }),
    );
    if (!overdue) return { status: "contacted-or-unassigned" };

    try { await inngest.send({ name: "lead/contact-overdue", data: { leadId, tenantId } }); } catch (e) { console.error(e); }
    await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "lead.sla.overdue", status: "ok" });

    await step.sleep("escalate-window", `${Math.max(1, cfg.escalateMin - cfg.firstTouchSlaMin)}m`);
    const stillOpen = await step.run("check-escalate", async () =>
      withTenant(tenantId, async (tx) => {
        const [l] = await tx.select({ contacted: lead.firstRepContactAt, owner: lead.assignedUserId }).from(lead).where(eq(lead.id, leadId));
        return l && l.contacted == null ? { owner: l.owner } : null;
      }),
    );
    if (!stillOpen) return { status: "contacted-after-overdue" };

    const reassigned = await step.run("reassign", async () =>
      withTenant(tenantId, async (tx) => {
        const candidates = await getAssignmentCandidates(tx, tenantId);
        const next = pickReassignee(candidates, stillOpen.owner);
        if (!next) return null;
        await setLeadOwner(tx, { tenantId, leadId, userId: next });
        return next;
      }),
    );
    await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "lead.sla.escalated", status: reassigned ? "ok" : "skipped", error: reassigned ? null : "no-candidate" });
    return { status: "escalated", reassigned };
  },
);
