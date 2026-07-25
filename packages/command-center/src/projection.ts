import type { DomainEvent, PayloadFor } from "@savvy/orchestrator";
import { businessDateOf } from "./day-window";
import { emptyMetrics, type DailyMetrics } from "./metrics";

const SLA_MS = 5 * 60_000;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function projectDay(events: DomainEvent[], businessDate: string): DailyMetrics {
  const day = events.filter((e) => businessDateOf(e.occurredAt) === businessDate);
  const m = emptyMetrics(businessDate);

  // speed-to-lead: pair lead.created with the first lead.first_touch by leadId (same day)
  const createdAt = new Map<string, number>();
  const firstTouchAt = new Map<string, number>();

  const stars: number[] = [];
  const margins: number[] = [];
  const pastDueByInvoice = new Map<string, number>(); // latest daysPastDue per invoice

  for (const e of day) {
    switch (e.type) {
      case "lead.created": {
        const p = e.payload as PayloadFor<"lead.created">;
        m.topLine.leadsTotal += 1;
        m.topLine.leadsBySource[p.source] = (m.topLine.leadsBySource[p.source] ?? 0) + 1;
        createdAt.set(p.leadId, Date.parse(e.occurredAt));
        break;
      }
      case "lead.first_touch": {
        const p = e.payload as PayloadFor<"lead.first_touch">;
        const t = Date.parse(e.occurredAt);
        if (!firstTouchAt.has(p.leadId) || t < firstTouchAt.get(p.leadId)!) firstTouchAt.set(p.leadId, t);
        break;
      }
      case "appointment.set": m.topLine.appointmentsSet += 1; break;
      case "appointment.no_show": m.topLine.appointmentsNoShow += 1; break;
      case "contract.signed": {
        const p = e.payload as PayloadFor<"contract.signed">;
        m.topLine.contractsSigned += 1;
        m.topLine.contractValueCents += p.contractValueCents;
        break;
      }
      case "job.completed": m.topLine.jobsCompleted += 1; break;
      case "invoice.created": {
        const p = e.payload as PayloadFor<"invoice.created">;
        m.money.invoicedCents += p.amountCents;
        break;
      }
      case "payment.received": {
        const p = e.payload as PayloadFor<"payment.received">;
        m.money.cashCollectedCents += p.amountCents;
        break;
      }
      case "supplement.approved": {
        const p = e.payload as PayloadFor<"supplement.approved">;
        m.money.supplementsApprovedCents += p.amountCents;
        break;
      }
      case "invoice.past_due": {
        const p = e.payload as PayloadFor<"invoice.past_due">;
        pastDueByInvoice.set(p.invoiceId, p.daysPastDue);
        break;
      }
      case "review.posted": {
        const p = e.payload as PayloadFor<"review.posted">;
        m.quality.reviewsPosted += 1;
        stars.push(p.stars);
        break;
      }
      case "estimate.approved": {
        const p = e.payload as PayloadFor<"estimate.approved">;
        m.production.estimatesApproved += 1;
        margins.push(p.marginPct);
        break;
      }
      case "material.order.created": m.production.materialOrders += 1; break;
      default: break; // lifecycle / system events don't contribute business metrics
    }
  }

  // AR buckets (30/60/90) from the latest past-due reading per invoice
  for (const days of pastDueByInvoice.values()) {
    if (days >= 90) m.money.arPastDue.d90 += 1;
    else if (days >= 60) m.money.arPastDue.d60 += 1;
    else if (days >= 30) m.money.arPastDue.d30 += 1;
  }

  // speed-to-lead
  const durations: number[] = [];
  let underSla = 0;
  for (const [leadId, created] of createdAt) {
    const touched = firstTouchAt.get(leadId);
    if (touched !== undefined) {
      const dur = touched - created;
      durations.push(dur);
      if (dur <= SLA_MS) underSla += 1;
    }
  }
  m.speed.medianSpeedToLeadMs = median(durations);
  m.speed.pctLeadsUnder5Min = createdAt.size === 0 ? null : underSla / createdAt.size;

  m.quality.avgStars = stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : null;
  m.production.avgMarginPct = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null;

  return m;
}
