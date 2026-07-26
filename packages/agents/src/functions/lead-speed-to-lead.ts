import { adminDb, withTenant, lead, tenant, customer, property, user, eq, getAssignmentCandidates, setLeadOwner, recordAgentRun, DrizzleOrchestratorStore, recordException } from "@savvy/db";
import { parseSpeedToLeadConfig, pickReassignee, buildRepAlertSms } from "@savvy/core";
import { smsFrom, type SmsSender } from "@savvy/integrations";
import type { OrchestratorStore, EscalationRecord } from "@savvy/orchestrator";
import { publishDomainEvent, makeEvent } from "@savvy/orchestrator";
import { getTenantSms } from "../telephony";
import { inngest } from "../client";

// Open (non-terminal) lead statuses — a lost/won lead is never escalated or reassigned.
const OPEN: string[] = ["new", "contacted", "qualified", "booked"];

async function loadSla(tenantId: string): Promise<{ firstTouchSlaMin: number; escalateMin: number }> {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  return parseSpeedToLeadConfig((t?.settings as { speedToLead?: unknown } | null)?.speedToLead);
}

export type RepAlertCtx = {
  tenantId: string;
  source: string | null;
  ownerPhone: string | null;
  customerName: string | null;
  customerPhone: string | null;
  city: string | null;
};

/** Best-effort: text the assigned rep a tap-to-call alert for a fresh non-call lead.
 *  Returns a reason string. When no sender is injected, resolves per-tenant SMS creds.
 *  Injected sender (for tests) skips tenant resolution entirely. */
export async function runRepAlert(ctx: RepAlertCtx, sender?: SmsSender): Promise<string> {
  if (ctx.source === "inbound_call") return "skip-inbound";
  if (!ctx.ownerPhone) return "skip-no-rep-phone";
  if (!ctx.customerPhone) return "skip-no-lead-phone";
  const body = buildRepAlertSms({ name: ctx.customerName ?? "a new lead", city: ctx.city, leadPhone: ctx.customerPhone });
  // Resolve once: injected sender uses platform from; default path resolves per-tenant creds.
  const resolved = sender ? { sender, from: smsFrom() } : await getTenantSms(ctx.tenantId);
  try {
    await resolved.sender.sendSms({ to: ctx.ownerPhone, from: resolved.from, body });
    return "sent";
  } catch {
    return "send-failed";
  }
}

// --- Slice B bridge helper ------------------------------------------------
// Pure, DB-free (given a store) so it's unit-testable with an InMemoryStore.
// Publishes lead.sla_breach onto the domain-event bus once at the overdue
// point; the orchestrator's event-driven ESCALATIONS rules turn it into a
// "speed-to-lead-breach" hit. The idempotencyKey (keyed on leadId only, not
// per-attempt) means a later reassign step firing the same bridge again
// can't double-queue the escalation. Returns the escalation (if any) so the
// caller can project it into the Command Center exception queue via
// recordException.
export async function bridgeBreach(
  store: OrchestratorStore,
  a: { tenantId: string; leadId: string; minutes: number },
): Promise<{ breach?: EscalationRecord }> {
  const published = await publishDomainEvent(store, makeEvent({
    type: "lead.sla_breach", source: "savvy", tenantId: a.tenantId,
    correlationId: a.leadId, idempotencyKey: `lead.sla_breach:${a.leadId}`,
    payload: { leadId: a.leadId, minutes: a.minutes },
  }));
  if (!published.published) return {};
  const esc = published.escalations.find((e) => e.ruleId === "speed-to-lead-breach");
  return esc ? { breach: esc } : {};
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

    await step.run("alert-rep", async () => {
      const ctx = await withTenant(tenantId, async (tx) => {
        const [row] = await tx
          .select({
            source: lead.source,
            ownerPhone: user.phone,
            customerName: customer.name,
            customerPhone: customer.phone,
            city: property.city,
          })
          .from(lead)
          .leftJoin(user, eq(lead.assignedUserId, user.id))
          .leftJoin(customer, eq(lead.customerId, customer.id))
          .leftJoin(property, eq(lead.propertyId, property.id))
          .where(eq(lead.id, leadId));
        return row ? { tenantId, ...row } : null;
      });
      const reason = ctx ? await runRepAlert(ctx) : "no-lead";
      await recordAgentRun({ tenantId, leadId, agent: "comms", taskKey: "lead.rep.alert", status: reason === "sent" ? "ok" : "skipped", error: reason === "sent" ? null : reason });
      return { reason };
    });

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
      await recordAgentRun({ tenantId, leadId, agent: "orchestrator", taskKey: "lead.sla.overdue", status: "ok" });
      return { emitted: true };
    });

    // Slice B bridge: project the SLA breach onto the domain-event bus
    // (lead.sla_breach -> speed-to-lead-breach escalation). A separate,
    // sibling step (not nested inside emit-overdue) so it's durable + retried
    // independently, and fail-soft: a publish error must never unwind the
    // internal overdue event that already fired above. Emitted once, here,
    // at the overdue point — the lead.sla_breach:${leadId} idempotency key
    // means the reassign step below firing this again can't double-queue it.
    await step.run("bridge-breach", async () => {
      try {
        const store = new DrizzleOrchestratorStore();
        const { breach } = await bridgeBreach(store, { tenantId, leadId, minutes: cfg.firstTouchSlaMin });
        if (breach) await recordException(tenantId, breach);
      } catch (err) {
        console.error("bridge-breach: failed to publish SLA breach bridge event:", err instanceof Error ? err.message : err);
      }
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
      await recordAgentRun({ tenantId, leadId, agent: "orchestrator", taskKey: "lead.sla.escalated", status: next ? "ok" : "skipped", error: next ? null : "no-candidate" });
      return next;
    });
    return { status: "escalated", reassigned };
  },
);
