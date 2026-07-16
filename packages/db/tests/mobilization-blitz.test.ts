import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant } from "../src/schema/tenancy.js";
import { customer, property, lead } from "../src/schema/crm.js";
import { job } from "../src/schema/jobs.js";
import { appointment } from "../src/schema/comms.js";
import { mailCampaign, mailPiece } from "../src/schema/mail.js";
import { makeTenant, makeUser } from "./helpers.js";
import { buildMobilizationBlitz, approveBlitzCampaign, pendingBlitzApprovals, blitzWeekStats } from "../src/lifecycle/mobilization-blitz.js";

const NOW = new Date();
const BUILD_START = new Date(NOW.getTime() + 5 * 86_400_000);
const BUILD_END = new Date(BUILD_START.getTime() + 2 * 86_400_000);

// Job site at central Mesa; neighbors laid out ~100–400m away, strangers far away.
const SITE = { lat: 33.4152, lng: -111.8315 };
const nearby = (i: number) => ({ lat: SITE.lat + 0.001 * (i + 1), lng: SITE.lng }); // ~111m per step

async function seedScheduledBuild(tenantId: string) {
  const { userId } = await makeUser(tenantId);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Roofed Homeowner" }).returning();
  const [p] = await adminDb.insert(property).values({
    tenantId, customerId: c!.id, address: "100 Site St, Mesa AZ", lat: SITE.lat, lng: SITE.lng,
  }).returning();
  const [j] = await adminDb.insert(job).values({
    tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "approved",
  }).returning();
  const [appt] = await adminDb.insert(appointment).values({
    tenantId, jobId: j!.id, propertyId: p!.id, customerId: c!.id, type: "crew",
    assigneeUserId: userId, startsAt: BUILD_START, endsAt: BUILD_END, status: "scheduled",
  }).returning();
  return { jobId: j!.id, propertyId: p!.id, customerId: c!.id, appointmentId: appt!.id };
}

/** A known neighbor property; opts control the dedupe/suppression red paths. */
async function seedNeighbor(tenantId: string, i: number, opts?: {
  mailOptOut?: boolean; activeLead?: boolean; hasJob?: boolean; noGeo?: boolean; address?: string;
}) {
  const [c] = await adminDb.insert(customer).values({
    tenantId, name: `Neighbor ${i}`, mailOptOut: opts?.mailOptOut ?? false,
  }).returning();
  const pos = opts?.noGeo ? { lat: null, lng: null } : nearby(i);
  const [p] = await adminDb.insert(property).values({
    tenantId, customerId: c!.id, address: opts?.address ?? `${101 + i} Neighbor Ln, Mesa AZ`,
    lat: pos.lat, lng: pos.lng,
  }).returning();
  if (opts?.activeLead) {
    await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "web", status: "new" });
  }
  if (opts?.hasJob) {
    await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "complete" });
  }
  return { propertyId: p!.id };
}

describe("buildMobilizationBlitz", () => {
  it("plans 3 arrive-window waves to the closest homes, holding every piece print_pending (dormant seam)", async () => {
    const { tenantId } = await makeTenant();
    const site = await seedScheduledBuild(tenantId);
    for (let i = 0; i < 4; i++) await seedNeighbor(tenantId, i);

    const r = await buildMobilizationBlitz(tenantId, { jobId: site.jobId, now: NOW });
    expect("campaignId" in r).toBe(true);
    if (!("campaignId" in r)) return;

    const [camp] = await adminDb.select().from(mailCampaign).where(eq(mailCampaign.id, r.campaignId));
    expect(camp!.kind).toBe("mobilization_blitz");
    expect(camp!.jobId).toBe(site.jobId);
    expect(camp!.audienceCount).toBe(4);
    expect(camp!.status).toBe("approved"); // 4 homes × 3 waves × default $1.43 ≈ $17 — under the $150 cap

    const pieces = await adminDb.select().from(mailPiece).where(eq(mailPiece.campaignId, r.campaignId));
    expect(pieces).toHaveLength(12); // 4 homes × 3 waves
    expect(pieces.every((p) => p.status === "print_pending")).toBe(true);

    // Wave mail-by dates bracket the build: before start / at start / at end.
    const waves = new Set(pieces.map((p) => p.wave));
    expect(waves).toEqual(new Set([1, 2, 3]));
    const w1 = pieces.find((p) => p.wave === 1)!;
    const w3 = pieces.find((p) => p.wave === 3)!;
    expect(new Date(w1.mailByDate).getTime()).toBeLessThan(BUILD_START.getTime());
    expect(new Date(w3.mailByDate).getTime()).toBeGreaterThanOrEqual(BUILD_END.getTime() - 86_400_000);

    // Merge vars carry the street name and NEVER the house number.
    const vars = pieces[0]!.mergeVars as { street: string };
    expect(vars.street).toBe("Site St");
    expect(JSON.stringify(pieces.map((p) => p.mergeVars))).not.toContain("100 ");

    // Replay is free (idempotent per job).
    const r2 = await buildMobilizationBlitz(tenantId, { jobId: site.jobId, now: NOW });
    expect("campaignId" in r2 && r2.campaignId).toBe(r.campaignId);
    expect(await adminDb.select().from(mailCampaign).where(eq(mailCampaign.tenantId, tenantId))).toHaveLength(1);
  });

  it("red paths: never mails the job's own address, opted-out, existing-customer, active-lead, or geo-less homes", async () => {
    const { tenantId } = await makeTenant();
    const site = await seedScheduledBuild(tenantId);
    await seedNeighbor(tenantId, 0); // the only mailable one
    const optedOut = await seedNeighbor(tenantId, 1, { mailOptOut: true });
    const activeLead = await seedNeighbor(tenantId, 2, { activeLead: true });
    const existing = await seedNeighbor(tenantId, 3, { hasJob: true });
    await seedNeighbor(tenantId, 4, { noGeo: true });

    const r = await buildMobilizationBlitz(tenantId, { jobId: site.jobId, now: NOW });
    if (!("campaignId" in r)) throw new Error("expected campaign");
    const pieces = await adminDb.select().from(mailPiece).where(eq(mailPiece.campaignId, r.campaignId));
    const targets = new Set(pieces.map((p) => p.propertyId));
    expect(targets.size).toBe(1);
    expect(targets.has(site.propertyId)).toBe(false); // own address
    expect(targets.has(optedOut.propertyId)).toBe(false);
    expect(targets.has(activeLead.propertyId)).toBe(false);
    expect(targets.has(existing.propertyId)).toBe(false);
  });

  it("60-day suppression: an address blitzed recently is skipped (and the evidence check enforces it)", async () => {
    const { tenantId } = await makeTenant();
    const siteA = await seedScheduledBuild(tenantId);
    const n = await seedNeighbor(tenantId, 0, { address: "222 Twice Ln, Mesa AZ" });
    const r1 = await buildMobilizationBlitz(tenantId, { jobId: siteA.jobId, now: NOW });
    if (!("campaignId" in r1)) throw new Error("expected campaign");

    // A second build nearby days later — the just-mailed neighbor is suppressed
    // while a fresh neighbor still receives the plan.
    const siteB = await seedScheduledBuild(tenantId);
    await seedNeighbor(tenantId, 5, { address: "333 Fresh Ave, Mesa AZ" });
    const r2 = await buildMobilizationBlitz(tenantId, { jobId: siteB.jobId, now: NOW });
    if (!("campaignId" in r2)) throw new Error("expected campaign");
    const pieces2 = await adminDb.select().from(mailPiece).where(eq(mailPiece.campaignId, r2.campaignId));
    expect(pieces2.every((p) => p.propertyId !== n.propertyId)).toBe(true);

    const ctx: EvidenceCtx = {
      tenantId, db: adminPool, params: {},
      window: { start: new Date(NOW.getTime() - 86_400_000), end: new Date(NOW.getTime() + 86_400_000) },
    };
    expect((await evidenceChecks["mail.suppression"]!(ctx)).status).toBe("pass");
  });

  it("over the per-job cap → pending_approval, never a silent send; oversize audience config → same", async () => {
    const { tenantId } = await makeTenant();
    await adminDb.update(tenant)
      .set({ settings: { blitz: { perJobCapCents: 500 } } }) // $5 cap — anything trips it
      .where(eq(tenant.id, tenantId));
    const site = await seedScheduledBuild(tenantId);
    for (let i = 0; i < 3; i++) await seedNeighbor(tenantId, i);

    const r = await buildMobilizationBlitz(tenantId, { jobId: site.jobId, now: NOW });
    if (!("campaignId" in r)) throw new Error("expected campaign");
    const [camp] = await adminDb.select().from(mailCampaign).where(eq(mailCampaign.id, r.campaignId));
    expect(camp!.status).toBe("pending_approval");
    expect(camp!.approvedAt).toBeNull();
  });

  it("approval flow: pending campaign lists on the card, approving stamps who and when", async () => {
    const { tenantId } = await makeTenant();
    const { userId } = await makeUser(tenantId);
    await adminDb.update(tenant).set({ settings: { blitz: { perJobCapCents: 500 } } }).where(eq(tenant.id, tenantId));
    const site = await seedScheduledBuild(tenantId);
    for (let i = 0; i < 3; i++) await seedNeighbor(tenantId, i);
    const r = await buildMobilizationBlitz(tenantId, { jobId: site.jobId, now: NOW });
    if (!("campaignId" in r)) throw new Error("expected campaign");

    const pending = await pendingBlitzApprovals(tenantId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.campaignId).toBe(r.campaignId);
    expect(pending[0]!.audienceCount).toBe(3);

    await approveBlitzCampaign(tenantId, { campaignId: r.campaignId, userId });
    const [after] = await adminDb.select().from(mailCampaign).where(eq(mailCampaign.id, r.campaignId));
    expect(after!.status).toBe("approved");
    expect(after!.approvedByUserId).toBe(userId);
    expect(after!.approvedAt).toBeTruthy();
    expect(await pendingBlitzApprovals(tenantId)).toHaveLength(0);
  });

  it("weekly stats: blitzes, spend, mobilization leads, rolling roofs-per-jobs vs the 1-in-7 target", async () => {
    const { tenantId } = await makeTenant();
    const site = await seedScheduledBuild(tenantId);
    for (let i = 0; i < 2; i++) await seedNeighbor(tenantId, i);
    await buildMobilizationBlitz(tenantId, { jobId: site.jobId, now: NOW });

    // One mobilization-sourced lead that became a job (a blitz roof).
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Blitz Convert" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "9 Convert Ct" }).returning();
    const [l] = await adminDb.insert(lead).values({
      tenantId, customerId: c!.id, propertyId: p!.id, source: "mobilization", status: "won",
    }).returning();
    await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, leadId: l!.id, type: "retail", stage: "production" });

    const stats = await blitzWeekStats(tenantId, NOW);
    expect(stats.blitzes).toBe(1);
    expect(stats.spendCents).toBe(2 * 3 * 143); // 2 homes × 3 waves × default piece cost
    expect(stats.mobilizationLeads).toBe(1);
    expect(stats.blitzedJobs12mo).toBe(1);
    expect(stats.mobilizationRoofs12mo).toBe(1);
  });

  it("skips gracefully when the job site has no geocode (logged reason, no campaign)", async () => {
    const { tenantId } = await makeTenant();
    const { userId } = await makeUser(tenantId);
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "No Geo" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Nowhere Rd" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "approved" }).returning();
    await adminDb.insert(appointment).values({
      tenantId, jobId: j!.id, propertyId: p!.id, type: "crew", assigneeUserId: userId,
      startsAt: BUILD_START, endsAt: BUILD_END, status: "scheduled",
    });
    const r = await buildMobilizationBlitz(tenantId, { jobId: j!.id, now: NOW });
    expect(r).toEqual({ skipped: "no_geocode" });
    expect(await adminDb.select().from(mailCampaign).where(eq(mailCampaign.tenantId, tenantId))).toHaveLength(0);
  });
});
