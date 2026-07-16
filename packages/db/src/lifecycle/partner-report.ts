import { createHmac } from "node:crypto";
import { and, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import {
  quarterKeyInTimeZone,
  priorQuarterKey,
  quarterRange,
  requireSecret,
  rollupByClass,
  type PartnerClassRollup,
} from "@savvy/core";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { partner } from "../schema/partner";
import { partnerReport } from "../schema/partner-report";
import { relationshipTouch } from "../schema/relationship";
import { certRequest } from "../schema/cert";
import { lead } from "../schema/crm";
import { job } from "../schema/jobs";
import { estimate } from "../schema/finance";
import { inspection } from "../schema/inspection";
import { bookingLink } from "../schema/booking-link";
import { tenant as tenantTbl } from "../schema/tenancy";
import { schedulePartnerTouch } from "./relationship-touch";
import { partnerValueRows, pendingCDecisions } from "./partner-value";

export type PartnerReportPayload = {
  quarterKey: string;
  sent: number;
  inspected: number;
  estimated: number;
  won: number;
  certsDelivered: number;
  netCents: number;
};

// Permanent deterministic link, same recipe as record/cert pages.
function reportSig(tenantId: string, reportId: string): string {
  const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
  return createHmac("sha256", secret).update(`preport:${tenantId}:${reportId}`).digest("base64url").slice(0, 24);
}

export function partnerReportLinkToken(tenantId: string, reportId: string): string {
  return `${reportId}.${reportSig(tenantId, reportId)}`;
}

export async function resolvePartnerReportLink(code: string): Promise<{ tenantId: string; reportId: string } | null> {
  const [row] = await adminDb.select({ tenantId: bookingLink.tenantId, token: bookingLink.token, kind: bookingLink.kind })
    .from(bookingLink).where(eq(bookingLink.code, code));
  if (!row || row.kind !== "partner_report") return null;
  const [reportId, sig] = row.token.split(".");
  if (!reportId || sig !== reportSig(row.tenantId, reportId)) return null;
  return { tenantId: row.tenantId, reportId };
}

async function mintReportLink(tenantId: string, reportId: string): Promise<string> {
  const token = partnerReportLinkToken(tenantId, reportId);
  const [existing] = await adminDb.select({ code: bookingLink.code }).from(bookingLink)
    .where(and(eq(bookingLink.tenantId, tenantId), eq(bookingLink.token, token)));
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Math.random().toString(36).slice(2, 9);
    try {
      await adminDb.insert(bookingLink).values({ tenantId, code, token, kind: "partner_report", expiresAt: null });
      return code;
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message.includes("23505"))) throw err;
    }
  }
  throw new Error("Failed to mint partner report link");
}

/** The prior quarter's funnel for ONE partner, window-scoped (not trailing-12mo). */
async function quarterFunnel(
  tenantId: string,
  partnerId: string,
  window: { start: Date; end: Date },
): Promise<Omit<PartnerReportPayload, "quarterKey" | "netCents">> {
  return withTenant(tenantId, async (tx) => {
    const leads = await tx.select({ id: lead.id }).from(lead)
      .where(and(
        eq(lead.tenantId, tenantId), eq(lead.partnerId, partnerId),
        gte(lead.createdAt, window.start), lt(lead.createdAt, window.end),
      ));
    const leadIds = leads.map((l) => l.id);

    let inspected = 0;
    let estimated = 0;
    let won = 0;
    if (leadIds.length) {
      const insp = await tx.selectDistinct({ leadId: inspection.leadId }).from(inspection)
        .where(and(eq(inspection.tenantId, tenantId), inArray(inspection.leadId, leadIds), sql`${inspection.completedAt} is not null`));
      inspected = insp.length;
      const est = await tx.selectDistinct({ leadId: estimate.leadId }).from(estimate)
        .where(and(eq(estimate.tenantId, tenantId), inArray(estimate.leadId, leadIds)));
      estimated = est.length;
      const jobs = await tx.selectDistinct({ leadId: job.leadId }).from(job)
        .where(and(eq(job.tenantId, tenantId), inArray(job.leadId, leadIds)));
      won = jobs.length;
    }

    const certs = await tx.select({ id: certRequest.id }).from(certRequest)
      .where(and(
        eq(certRequest.tenantId, tenantId), eq(certRequest.partnerId, partnerId),
        eq(certRequest.status, "delivered"),
        gte(certRequest.deliveredAt, window.start), lt(certRequest.deliveredAt, window.end),
      ));

    return { sent: leadIds.length, inspected, estimated, won, certsDelivered: certs.length };
  });
}

/**
 * Quarter-start generation (+ daily catch-up for partners graded A/B
 * mid-quarter): each active A/B partner gets ONE frozen snapshot of the PRIOR
 * quarter, a permanent tokenized page, and a governor touch (email) that the
 * sweep delivers. C partners are deliberately skipped — decision cards, never
 * report cards.
 */
export async function generateQuarterlyPartnerReports(
  tenantId: string,
  now: Date,
): Promise<{ generated: number; quarterKey: string }> {
  const [t] = await adminDb.select({ timezone: tenantTbl.timezone }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const tz = t?.timezone ?? "America/Phoenix";
  const qk = priorQuarterKey(quarterKeyInTimeZone(now, tz));
  const window = quarterRange(qk, tz);

  const candidates = await withTenant(tenantId, (tx) =>
    tx.select({ id: partner.id }).from(partner)
      .where(and(
        eq(partner.tenantId, tenantId), eq(partner.status, "active"),
        inArray(partner.grade, ["A", "B"]),
        sql`not exists (select 1 from ${partnerReport} r where r.partner_id = ${partner.id} and r.quarter_key = ${qk})`,
      )),
  );
  if (candidates.length === 0) return { generated: 0, quarterKey: qk };

  const valueRows = await partnerValueRows(tenantId, now);
  const netById = new Map(valueRows.map((r) => [r.partnerId, r.netCents]));

  let generated = 0;
  for (const c of candidates) {
    const funnel = await quarterFunnel(tenantId, c.id, window);
    const payload: PartnerReportPayload = { quarterKey: qk, ...funnel, netCents: netById.get(c.id) ?? 0 };

    const inserted = await withTenant(tenantId, (tx) =>
      tx.insert(partnerReport).values({ tenantId, partnerId: c.id, quarterKey: qk, payload })
        .onConflictDoNothing().returning({ id: partnerReport.id }),
    );
    const reportId = inserted[0]?.id;
    if (!reportId) continue; // raced — the other writer finishes the stamps

    const reportCode = await mintReportLink(tenantId, reportId);
    const touch = await schedulePartnerTouch({
      tenantId, partnerId: c.id, program: "partner_quarterly", channel: "email",
      scheduledFor: now, sourceRef: `${c.id}:quarterly:${qk}`,
    });
    await withTenant(tenantId, (tx) =>
      tx.update(partnerReport)
        .set({ reportCode, touchId: "touchId" in touch ? touch.touchId : null })
        .where(eq(partnerReport.id, reportId)),
    );
    generated++;
  }
  return { generated, quarterKey: qk };
}

export type DuePartnerEmailTouch = {
  touchId: string;
  partnerId: string;
  partnerName: string;
  email: string | null;
  reportCode: string | null;
  quarterKey: string | null;
};

/** Unsent, unsuppressed partner email touches that are due — the sweep's send list. */
export async function duePartnerEmailTouches(tenantId: string, now: Date): Promise<DuePartnerEmailTouch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select({
      touchId: relationshipTouch.id,
      partnerId: relationshipTouch.partnerId,
      partnerName: partner.name,
      email: partner.email,
      reportCode: partnerReport.reportCode,
      quarterKey: partnerReport.quarterKey,
    }).from(relationshipTouch)
      .innerJoin(partner, eq(relationshipTouch.partnerId, partner.id))
      .leftJoin(partnerReport, eq(partnerReport.touchId, relationshipTouch.id))
      .where(and(
        eq(relationshipTouch.tenantId, tenantId),
        eq(relationshipTouch.program, "partner_quarterly"),
        eq(relationshipTouch.channel, "email"),
        isNull(relationshipTouch.sentAt),
        isNull(relationshipTouch.suppressedReason),
        lte(relationshipTouch.scheduledFor, now),
      ));
    return rows.map((r) => ({ ...r, partnerId: r.partnerId! }));
  });
}

export type PartnerReportPage = {
  reportId: string;
  quarterKey: string;
  partnerName: string;
  partnerOrg: string | null;
  companyName: string;
  payload: PartnerReportPayload;
  createdAt: Date;
};

export async function getPartnerReportPageData(tenantId: string, reportId: string): Promise<PartnerReportPage | null> {
  return withTenant(tenantId, async (tx) => {
    const [r] = await tx.select().from(partnerReport)
      .where(and(eq(partnerReport.tenantId, tenantId), eq(partnerReport.id, reportId)));
    if (!r) return null;
    const [p] = await tx.select({ name: partner.name, org: partner.org }).from(partner).where(eq(partner.id, r.partnerId));
    const [t] = await tx.select({ name: tenantTbl.name }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
    if (!p) return null;
    return {
      reportId: r.id,
      quarterKey: r.quarterKey,
      partnerName: p.name,
      partnerOrg: p.org,
      companyName: t?.name ?? "",
      payload: r.payload as PartnerReportPayload,
      createdAt: r.createdAt,
    };
  });
}

export type QuarterlyRanking = {
  quarterKey: string;
  rows: Awaited<ReturnType<typeof partnerValueRows>>;
  rollups: PartnerClassRollup[];
  movers: Array<{ partnerId: string; name: string; deltaCents: number }>;
  cCardsPending: number;
};

/**
 * The internal quarterly artifact: everyone ranked by net, class rollups,
 * biggest movers vs the PRIOR report snapshot, and outstanding C cards.
 */
export async function internalQuarterlyRanking(tenantId: string, now: Date): Promise<QuarterlyRanking> {
  const [t] = await adminDb.select({ timezone: tenantTbl.timezone }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const tz = t?.timezone ?? "America/Phoenix";
  const qk = priorQuarterKey(quarterKeyInTimeZone(now, tz));
  const priorQk = priorQuarterKey(qk);

  const rows = await partnerValueRows(tenantId, now);
  const priorReports = await withTenant(tenantId, (tx) =>
    tx.select({ partnerId: partnerReport.partnerId, payload: partnerReport.payload }).from(partnerReport)
      .where(and(eq(partnerReport.tenantId, tenantId), eq(partnerReport.quarterKey, priorQk))),
  );
  const priorNet = new Map(priorReports.map((r) => [r.partnerId, (r.payload as PartnerReportPayload).netCents]));

  const movers = rows
    .filter((r) => priorNet.has(r.partnerId))
    .map((r) => ({ partnerId: r.partnerId, name: r.name, deltaCents: r.netCents - priorNet.get(r.partnerId)! }))
    .sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents))
    .slice(0, 3);

  const cCards = await pendingCDecisions(tenantId);

  return { quarterKey: qk, rows, rollups: rollupByClass(rows), movers, cCardsPending: cCards.length };
}

/** Reports generated in the trailing week — powers the one digest line that links the ranking. */
export async function freshQuarterlyReportCount(tenantId: string, now: Date): Promise<number> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ id: partnerReport.id }).from(partnerReport)
      .where(and(
        eq(partnerReport.tenantId, tenantId),
        gte(partnerReport.createdAt, new Date(now.getTime() - 7 * 86_400_000)),
      )),
  );
  return rows.length;
}
