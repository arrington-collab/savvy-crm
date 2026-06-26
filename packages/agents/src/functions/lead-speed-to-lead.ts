import { adminDb, withTenant, lead, tenant, eq, getAssignmentCandidates, setLeadOwner, recordAgentRun } from "@savvy/db";
import { parseSpeedToLeadConfig, pickReassignee } from "@savvy/core";
import { inngest } from "../client";

// Open (non-terminal) lead statuses — a lost/won lead is never escalated or reassigned.
const OPEN: string[] = ["new", "contacted", "qualified", "booked"];

async function loadSla(tenantId: string): Promise<{ firstTouchSlaMin: number; escalateMin: number }> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  return parseSpeedToLeadConfig((t?.settings as { speedToLead?: unknown } | null)?.speedToLead);
}

export const leadSpeedToLead = inngest.createFunction(
  {
    id: "lead-speed-to-lead", concurrency: { limit: 5 },
    cancelOn: [
      { event: "lead/contacted", match: "data.leadId" },
      { event: "lead/disqualified", match: "data.leadId" },
    ],
  },
  { event: "lead/created" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;
    const cfg = await step.run("load-sla", () => loadSla(tenantId));

    await step.sleep("first-touch-sla", `${cfg.firstTouchSlaMin}m`);
    const overdue = await step.run("check-overdue", async () =>
      withTenant(tenantId, async (tx) => {
        const [l] = await tx.select({ contacted: lead.firstRepContactAt, owner: lead.assignedUserId, status: lead.status }).from(lead).where(eq(lead.id, leadId));
        return l && l.contacted == null && l.owner != null && OPEN.includes(l.status) ? { owner: l.owner } : null;
      }),
    );
    if (!overdue) return { status: "contacted-or-unassigned" };

    // Emit + audit inside a memoized step so a downstream retry can't double-fire (idempotency).
    await step.run("emit-overdue", async () => {
      await inngest.send({ name: "lead/contact-overdue", data: { leadId, tenantId } });
      await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "lead.sla.overdue", status: "ok" });
      return { emitted: true };
    });

    await step.sleep("escalate-window", `${Math.max(1, cfg.escalateMin - cfg.firstTouchSlaMin)}m`);
    const stillOpen = await step.run("check-escalate", async () =>
      withTenant(tenantId, async (tx) => {
        const [l] = await tx.select({ contacted: lead.firstRepContactAt, owner: lead.assignedUserId, status: lead.status }).from(lead).where(eq(lead.id, leadId));
        return l && l.contacted == null && OPEN.includes(l.status) ? { owner: l.owner } : null;
      }),
    );
    if (!stillOpen) return { status: "contacted-after-overdue" };

    const reassigned = await step.run("reassign", async () => {
      const next = await withTenant(tenantId, async (tx) => {
        const candidates = await getAssignmentCandidates(tx, tenantId);
        const picked = pickReassignee(candidates, stillOpen.owner);
        if (!picked) return null;
        await setLeadOwner(tx, { tenantId, leadId, userId: picked });
        return picked;
      });
      // Audit inside the same step so it's memoized with the reassign decision.
      await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "lead.sla.escalated", status: next ? "ok" : "skipped", error: next ? null : "no-candidate" });
      return next;
    });
    return { status: "escalated", reassigned };
  },
);
