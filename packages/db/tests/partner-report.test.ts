import { describe, it, expect } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { evidenceChecks, quarterKeyInTimeZone, priorQuarterKey } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { partner } from "../src/schema/partner.js";
import { partnerReport } from "../src/schema/partner-report.js";
import { relationshipTouch } from "../src/schema/relationship.js";
import { customer, property, lead } from "../src/schema/crm.js";
import { job } from "../src/schema/jobs.js";
import { inspection } from "../src/schema/inspection.js";
import { bookingLink } from "../src/schema/booking-link.js";
import { makeTenant } from "./helpers.js";
import { findOrCreatePartner } from "../src/lifecycle/partner.js";
import { schedulePartnerTouch } from "../src/lifecycle/relationship-touch.js";
import {
  generateQuarterlyPartnerReports,
  duePartnerEmailTouches,
  internalQuarterlyRanking,
  getPartnerReportPageData,
  resolvePartnerReportLink,
} from "../src/lifecycle/partner-report.js";

// Real-clock anchored: reports summarize the PRIOR quarter relative to DB now().
const NOW = new Date();
const TZ = "America/Phoenix";
const CURRENT_Q = quarterKeyInTimeZone(NOW, TZ);
const PRIOR_Q = priorQuarterKey(CURRENT_Q);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
// A timestamp safely inside the PRIOR quarter: 40 days before the current
// quarter began (quarters are ~91 days, so start-of-quarter minus 40d is prior).
function priorQuarterInstant(): Date {
  const qStartMonth = { Q1: 0, Q2: 3, Q3: 6, Q4: 9 }[CURRENT_Q.slice(5) as "Q1" | "Q2" | "Q3" | "Q4"];
  const qStart = new Date(Date.UTC(Number(CURRENT_Q.slice(0, 4)), qStartMonth, 1, 12));
  return new Date(qStart.getTime() - 40 * 86_400_000);
}

async function seedGradedPartner(tenantId: string, name: string, grade: "A" | "B" | "C"): Promise<string> {
  const { id } = await findOrCreatePartner(tenantId, { name, class: "realtor" });
  await adminDb.update(partner)
    .set({ grade, gradedAt: NOW, createdAt: daysAgo(200) })
    .where(eq(partner.id, id));
  return id;
}

async function seedQuarterLead(tenantId: string, partnerId: string, at: Date, opts?: { won?: boolean; inspected?: boolean }) {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `QR Cust ${crypto.randomUUID().slice(0, 6)}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${crypto.randomUUID().slice(0, 6)} Quarterly Ln` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "realtor", partnerId, createdAt: at }).returning();
  if (opts?.inspected) {
    await adminDb.insert(inspection).values({ tenantId, leadId: l!.id, propertyId: p!.id, status: "published", completedAt: at });
  }
  if (opts?.won) {
    await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, leadId: l!.id, type: "retail", stage: "production", createdAt: at });
  }
  return l!.id;
}

describe("schedulePartnerTouch", () => {
  it("writes a partner-scoped ledger row (no customer) and is idempotent by sourceRef", async () => {
    const { tenantId } = await makeTenant();
    const pid = await seedGradedPartner(tenantId, "Touch Partner", "A");
    const r1 = await schedulePartnerTouch({
      tenantId, partnerId: pid, program: "partner_quarterly", channel: "email",
      scheduledFor: NOW, sourceRef: `${pid}:quarterly:${PRIOR_Q}`,
    });
    const r2 = await schedulePartnerTouch({
      tenantId, partnerId: pid, program: "partner_quarterly", channel: "email",
      scheduledFor: NOW, sourceRef: `${pid}:quarterly:${PRIOR_Q}`,
    });
    expect("touchId" in r1 && r1.touchId).toBeTruthy();
    expect("touchId" in r2 && (r2 as { existing?: boolean }).existing).toBe(true);

    const rows = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.tenantId, tenantId), eq(relationshipTouch.partnerId, pid)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customerId).toBeNull();
  });
});

describe("generateQuarterlyPartnerReports", () => {
  it("A/B partners get a prior-quarter snapshot + link + touch; C partners get NOTHING (zero shame mechanics); idempotent", async () => {
    const { tenantId } = await makeTenant();
    const a = await seedGradedPartner(tenantId, "Ada A", "A");
    const b = await seedGradedPartner(tenantId, "Bea B", "B");
    const c = await seedGradedPartner(tenantId, "Cal C", "C");

    const inQ = priorQuarterInstant();
    await seedQuarterLead(tenantId, a, inQ, { inspected: true, won: true });
    await seedQuarterLead(tenantId, a, inQ);
    await seedQuarterLead(tenantId, a, daysAgo(500)); // outside the quarter — excluded

    const r1 = await generateQuarterlyPartnerReports(tenantId, NOW);
    const r2 = await generateQuarterlyPartnerReports(tenantId, NOW);
    expect(r1.generated).toBe(2); // A + B, never C
    expect(r2.generated).toBe(0);

    const reports = await adminDb.select().from(partnerReport).where(eq(partnerReport.tenantId, tenantId));
    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.quarterKey === PRIOR_Q)).toBe(true);
    expect(reports.find((r) => r.partnerId === c)).toBeUndefined();

    const adaReport = reports.find((r) => r.partnerId === a)!;
    const payload = adaReport.payload as { sent: number; inspected: number; won: number };
    expect(payload.sent).toBe(2); // the 500-day-old lead is not in the quarter
    expect(payload.inspected).toBe(1);
    expect(payload.won).toBe(1);
    expect(adaReport.reportCode).toBeTruthy();
    expect(adaReport.touchId).toBeTruthy();

    const links = await adminDb.select().from(bookingLink)
      .where(and(eq(bookingLink.tenantId, tenantId), eq(bookingLink.kind, "partner_report")));
    expect(links).toHaveLength(2);
  });
});

describe("duePartnerEmailTouches + report page data", () => {
  it("lists unsent partner email touches with the report link; page data carries honest outcomes", async () => {
    const { tenantId } = await makeTenant();
    const a = await seedGradedPartner(tenantId, "Mail Partner", "A");
    await adminDb.update(partner).set({ email: "mail.partner@example.test" }).where(eq(partner.id, a));
    await seedQuarterLead(tenantId, a, priorQuarterInstant(), { won: true });
    await generateQuarterlyPartnerReports(tenantId, NOW);

    const due = await duePartnerEmailTouches(tenantId, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]!.partnerId).toBe(a);
    expect(due[0]!.email).toBe("mail.partner@example.test");
    expect(due[0]!.reportCode).toBeTruthy();

    const link = await resolvePartnerReportLink(due[0]!.reportCode!);
    expect(link?.tenantId).toBe(tenantId);
    const page = await getPartnerReportPageData(tenantId, link!.reportId);
    expect(page).not.toBeNull();
    expect(page!.partnerName).toBe("Mail Partner");
    expect(page!.quarterKey).toBe(PRIOR_Q);
    expect(page!.payload.sent).toBe(1);
    expect(page!.payload.won).toBe(1);
  });
});

describe("internalQuarterlyRanking", () => {
  it("ranks by net with class rollups and counts outstanding C cards", async () => {
    const { tenantId } = await makeTenant();
    const a = await seedGradedPartner(tenantId, "Ranked A", "A");
    const c = await seedGradedPartner(tenantId, "Ranked C", "C");
    await adminDb.update(partner).set({ cCardStatus: "pending" }).where(eq(partner.id, c));
    await seedQuarterLead(tenantId, a, priorQuarterInstant(), { won: true });

    const art = await internalQuarterlyRanking(tenantId, NOW);
    expect(art.quarterKey).toBe(PRIOR_Q);
    expect(art.rows.length).toBe(2);
    expect(art.rollups.length).toBeGreaterThan(0);
    expect(art.cCardsPending).toBe(1);
  });
});

describe("evidence: partner.quarterly", () => {
  const run = (tenantId: string) => {
    const ctx: EvidenceCtx = {
      tenantId, db: adminPool, params: {},
      window: { start: daysAgo(1), end: new Date(NOW.getTime() + 86_400_000) },
    };
    return evidenceChecks["partner.quarterly"]!(ctx);
  };

  it("an A/B partner without a prior-quarter report fails; generation heals it; C partners never violate", async () => {
    const { tenantId } = await makeTenant();
    await seedGradedPartner(tenantId, "Missing Report", "A");
    await seedGradedPartner(tenantId, "C No Report", "C");

    const bad = await run(tenantId);
    expect(bad.status).toBe("fail");

    await generateQuarterlyPartnerReports(tenantId, NOW);
    const clean = await run(tenantId);
    expect(clean.status).toBe("pass");
  });

  it("a partner created this quarter is exempt until next quarter", async () => {
    const { tenantId } = await makeTenant();
    const { id } = await findOrCreatePartner(tenantId, { name: "Brand New", class: "realtor" });
    await adminDb.update(partner).set({ grade: "A", gradedAt: NOW }).where(eq(partner.id, id)); // createdAt stays now
    const r = await run(tenantId);
    expect(r.status).toBe("pass");
  });
});
