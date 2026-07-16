import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  assignPartnerGrade,
  medianDays,
  parsePartnerLedgerConfig,
  type PartnerGrade,
} from "@savvy/core";
import { withTenant } from "../tenant";
import { partner, partnerLedgerEntry } from "../schema/partner";
import { lead } from "../schema/crm";
import { job } from "../schema/jobs";
import { estimate, invoice } from "../schema/finance";
import { inspection } from "../schema/inspection";
import { tenant as tenantTbl } from "../schema/tenancy";

const YEAR_MS = 365 * 86_400_000;

export type PartnerValueRow = {
  partnerId: string;
  name: string;
  org: string | null;
  class: string;
  grade: string | null;
  sent: number;
  inspected: number;
  estimated: number;
  won: number;
  collectedGmCents: number;
  openPipelineCents: number;
  cost12moCents: number;
  netCents: number;
  medianDaysToConvert: number | null;
};

/**
 * The ledger view: trailing-12-month funnel + honestly-counted economics per
 * partner. VALUE is collected gross margin (paid invoices − known job cost,
 * jobs with unknown cost contribute nothing rather than a guess); open
 * pipeline (unaccepted estimates + active jobs) is shown SEPARATELY so new
 * partners aren't judged prematurely. Costs come from the slice-2 ledger.
 */
export async function partnerValueRows(tenantId: string, now: Date): Promise<PartnerValueRow[]> {
  return withTenant(tenantId, async (tx) => {
    const windowStart = new Date(now.getTime() - YEAR_MS);

    const partners = await tx.select({
      id: partner.id, name: partner.name, org: partner.org, class: partner.class, grade: partner.grade,
    }).from(partner).where(and(eq(partner.tenantId, tenantId), eq(partner.status, "active")));
    if (partners.length === 0) return [];

    const leads = await tx.select({ id: lead.id, partnerId: lead.partnerId, createdAt: lead.createdAt })
      .from(lead)
      .where(and(eq(lead.tenantId, tenantId), isNotNull(lead.partnerId), gte(lead.createdAt, windowStart)));
    const leadIds = leads.map((l) => l.id);

    const [inspections, estimates, jobs, ledger] = await Promise.all([
      leadIds.length
        ? tx.select({ leadId: inspection.leadId }).from(inspection)
            .where(and(eq(inspection.tenantId, tenantId), isNotNull(inspection.completedAt), inArray(inspection.leadId, leadIds)))
        : Promise.resolve([] as Array<{ leadId: string | null }>),
      leadIds.length
        ? tx.select({ leadId: estimate.leadId, status: estimate.status, total: estimate.total }).from(estimate)
            .where(and(eq(estimate.tenantId, tenantId), inArray(estimate.leadId, leadIds)))
        : Promise.resolve([] as Array<{ leadId: string | null; status: string; total: number | null }>),
      leadIds.length
        ? tx.select({
            id: job.id, leadId: job.leadId, stage: job.stage, createdAt: job.createdAt,
            valueEstimate: job.valueEstimate, valueFinal: job.valueFinal, costCents: job.costCents,
          }).from(job)
            .where(and(eq(job.tenantId, tenantId), inArray(job.leadId, leadIds)))
        : Promise.resolve([] as Array<{ id: string; leadId: string | null; stage: string; createdAt: Date; valueEstimate: number | null; valueFinal: number | null; costCents: number | null }>),
      tx.select({
        partnerId: partnerLedgerEntry.partnerId,
        costCents: sql<number>`sum(case when ${partnerLedgerEntry.direction} = 'cost' then ${partnerLedgerEntry.amountCents} else 0 end)`,
      }).from(partnerLedgerEntry)
        .where(and(eq(partnerLedgerEntry.tenantId, tenantId), gte(partnerLedgerEntry.occurredAt, windowStart)))
        .groupBy(partnerLedgerEntry.partnerId),
    ]);

    const leadPartner = new Map(leads.map((l) => [l.id, l.partnerId!]));
    const leadCreated = new Map(leads.map((l) => [l.id, l.createdAt]));
    const costByPartner = new Map(ledger.map((r) => [r.partnerId, Number(r.costCents)]));

    // Collected revenue per job. NOT a correlated raw-sql subquery on the jobs
    // select: drizzle renders `${job.id}` unqualified there, and inside the
    // subquery it captures invoice's own `id` — silently summing nothing.
    const jobIds = jobs.map((j) => j.id);
    const paidRows = jobIds.length
      ? await tx.select({ jobId: invoice.jobId, paid: sql<string>`sum(${invoice.amountPaid})` })
          .from(invoice)
          .where(and(eq(invoice.tenantId, tenantId), inArray(invoice.jobId, jobIds)))
          .groupBy(invoice.jobId)
      : [];
    const paidByJob = new Map(paidRows.map((r) => [r.jobId, Number(r.paid ?? 0)]));

    const acc = new Map<string, {
      sent: number; inspectedLeads: Set<string>; estimatedLeads: Set<string>; wonLeads: Set<string>;
      collectedGmCents: number; openPipelineCents: number; convertDays: number[];
    }>();
    const bucket = (pid: string) => {
      let b = acc.get(pid);
      if (!b) {
        b = { sent: 0, inspectedLeads: new Set(), estimatedLeads: new Set(), wonLeads: new Set(), collectedGmCents: 0, openPipelineCents: 0, convertDays: [] };
        acc.set(pid, b);
      }
      return b;
    };

    for (const l of leads) bucket(l.partnerId!).sent += 1;
    for (const i of inspections) {
      const pid = i.leadId ? leadPartner.get(i.leadId) : undefined;
      if (pid && i.leadId) bucket(pid).inspectedLeads.add(i.leadId);
    }
    for (const e of estimates) {
      const pid = e.leadId ? leadPartner.get(e.leadId) : undefined;
      if (!pid || !e.leadId) continue;
      const b = bucket(pid);
      b.estimatedLeads.add(e.leadId);
      if (e.status !== "accepted") b.openPipelineCents += e.total ?? 0;
    }
    for (const j of jobs) {
      const pid = j.leadId ? leadPartner.get(j.leadId) : undefined;
      if (!pid || !j.leadId) continue;
      const b = bucket(pid);
      b.wonLeads.add(j.leadId);
      const created = leadCreated.get(j.leadId);
      if (created) b.convertDays.push(Math.round((j.createdAt.getTime() - created.getTime()) / 86_400_000));
      // Collected GM: paid revenue against KNOWN cost only — no guessing.
      const paid = paidByJob.get(j.id) ?? 0;
      if (paid > 0 && j.costCents != null) b.collectedGmCents += paid - j.costCents;
      if (j.stage !== "complete" && j.stage !== "lost") b.openPipelineCents += j.valueFinal ?? j.valueEstimate ?? 0;
    }

    const rows = partners.map((p) => {
      const b = acc.get(p.id) ?? { sent: 0, inspectedLeads: new Set<string>(), estimatedLeads: new Set<string>(), wonLeads: new Set<string>(), collectedGmCents: 0, openPipelineCents: 0, convertDays: [] as number[] };
      const cost12moCents = costByPartner.get(p.id) ?? 0;
      return {
        partnerId: p.id, name: p.name, org: p.org, class: p.class, grade: p.grade,
        sent: b.sent,
        inspected: b.inspectedLeads.size,
        estimated: b.estimatedLeads.size,
        won: b.wonLeads.size,
        collectedGmCents: b.collectedGmCents,
        openPipelineCents: b.openPipelineCents,
        cost12moCents,
        netCents: b.collectedGmCents - cost12moCents,
        medianDaysToConvert: medianDays(b.convertDays),
      };
    });
    return rows.sort((a, b) => b.netCents - a.netCents);
  });
}

/**
 * Monthly grade stamp (cards, never cutoffs): A flips schedulingPriority; a
 * partner NEWLY graded C opens a pending decision card; an already-resolved C
 * stays resolved. Grades and gradedAt feed the partner.grades_current check.
 */
export async function recomputePartnerGrades(tenantId: string, now: Date): Promise<{ graded: number }> {
  const rows = await partnerValueRows(tenantId, now);
  return withTenant(tenantId, async (tx) => {
    const [t] = await tx.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
    const cfg = parsePartnerLedgerConfig((t?.settings as { partnerLedger?: unknown } | null)?.partnerLedger);

    for (const r of rows) {
      const grade: PartnerGrade = assignPartnerGrade({ netCents: r.netCents, wins: r.won, sent: r.sent }, cfg);
      const [prev] = await tx.select({ grade: partner.grade, cCardStatus: partner.cCardStatus })
        .from(partner).where(and(eq(partner.tenantId, tenantId), eq(partner.id, r.partnerId)));
      const freshC = grade === "C" && prev?.grade !== "C";
      await tx.update(partner).set({
        grade,
        gradedAt: now,
        schedulingPriority: grade === "A",
        ...(freshC ? { cCardStatus: "pending" as const, cCardResolution: null } : {}),
        ...(grade !== "C" ? { cCardStatus: null, cCardResolution: null } : {}),
      }).where(and(eq(partner.tenantId, tenantId), eq(partner.id, r.partnerId)));
    }
    return { graded: rows.length };
  });
}

/** Daily catch-up trigger: a partner created since the last monthly pass. */
export async function hasUngradedPartners(tenantId: string): Promise<boolean> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ id: partner.id }).from(partner)
      .where(and(eq(partner.tenantId, tenantId), eq(partner.status, "active"), sql`${partner.gradedAt} is null`))
      .limit(1),
  );
  return rows.length > 0;
}

export type CDecision = {
  partnerId: string;
  name: string;
  org: string | null;
  sent: number;
  cost12moCents: number;
  netCents: number;
};

/** Pending C-partner decision cards, with the numbers the card presents. */
export async function pendingCDecisions(tenantId: string): Promise<CDecision[]> {
  const pending = await withTenant(tenantId, (tx) =>
    tx.select({ id: partner.id }).from(partner)
      .where(and(eq(partner.tenantId, tenantId), eq(partner.cCardStatus, "pending"))),
  );
  if (pending.length === 0) return [];
  const ids = new Set(pending.map((p) => p.id));
  const rows = await partnerValueRows(tenantId, new Date());
  return rows.filter((r) => ids.has(r.partnerId)).map((r) => ({
    partnerId: r.partnerId, name: r.name, org: r.org, sent: r.sent, cost12moCents: r.cost12moCents, netCents: r.netCents,
  }));
}

/** Human resolution of a C card. slack_capacity_only also flips the scheduling flag. */
export async function resolveCDecision(
  tenantId: string,
  input: { partnerId: string; resolution: "conversation" | "slack_capacity_only" | "dismissed" },
): Promise<{ resolved: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const [p] = await tx.select({ cCardStatus: partner.cCardStatus }).from(partner)
      .where(and(eq(partner.tenantId, tenantId), eq(partner.id, input.partnerId)));
    if (!p || p.cCardStatus !== "pending") return { resolved: false };
    await tx.update(partner).set({
      cCardStatus: "resolved",
      cCardResolution: input.resolution,
      ...(input.resolution === "slack_capacity_only" ? { slackCapacityOnly: true } : {}),
    }).where(and(eq(partner.tenantId, tenantId), eq(partner.id, input.partnerId)));
    return { resolved: true };
  });
}
