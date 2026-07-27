import { describe, it, expect, vi } from "vitest";
import {
  adminDb, tenant, customer, property, job, document, productionUpdate, eq,
  ensureProductionPhaseTemplates, instantiateProductionPhases, ingestProductionMedia, setPhotoCustomerSafe,
  suppress,
} from "@savvy/db";
import { sendPhaseCompleteUpdate } from "./production-ho-update.js";

async function seedDoneVisiblePhase(opts: { safePhotos?: number; optOut?: boolean; language?: string; phone?: string } = {}) {
  const [t] = await adminDb.insert(tenant).values({
    name: "HOUpd", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    settings: { homeowner: { quietHours: { startHour: 0, endHour: 0 } } } as never,
  }).returning();
  const tenantId = t!.id;
  await ensureProductionPhaseTemplates(tenantId);
  const [c] = await adminDb.insert(customer).values({
    tenantId, name: "Homer Owner", phone: opts.phone ?? "+16025551000", smsOptOut: opts.optOut ?? false,
    smsConsentAt: new Date("2026-01-01"), preferredLanguage: opts.language ?? null,
  }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "12 Update Dr" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "repair", stage: "production" }).returning();
  await instantiateProductionPhases({ tenantId, jobId: j!.id });

  // Complete repair_work (customer-visible; evidence: 3 photos incl before+after).
  const shots = ["before", null, "after"] as const;
  for (let i = 0; i < 3; i++) {
    const [d] = await adminDb.insert(document).values({
      tenantId, jobId: j!.id, kind: "photo", source: "sitesnap",
      sitesnapPhotoId: `ss-${crypto.randomUUID()}`, qcStatus: "passed",
    }).returning();
    if (i < (opts.safePhotos ?? 2)) await setPhotoCustomerSafe({ tenantId, documentId: d!.id, safe: true });
    await ingestProductionMedia({ tenantId, jobId: j!.id, phaseKey: "repair_work", documentId: d!.id, shot: shots[i] });
  }
  return { tenantId, jobId: j!.id };
}

function fakeDeps(draft = "Repair work's done — everything sealed up tight. Cleanup is next.") {
  const sent: { to: string; body: string }[] = [];
  return {
    sent,
    ai: { complete: vi.fn(async () => ({ text: draft, model: "fake" })) },
    getTenantSms: (async () => ({
      sender: { sendSms: async (m: { to: string; body: string }) => { sent.push(m); return { providerId: "fake" }; } },
      from: "+15555550000",
    })) as never,
  };
}

describe("sendPhaseCompleteUpdate — the good kind of noise, auto-sent", () => {
  it("drafts warm plain language via the cheap capability, sends with the status link, logs the ledger row", async () => {
    const { tenantId, jobId } = await seedDoneVisiblePhase();
    const deps = fakeDeps();

    const res = await sendPhaseCompleteUpdate({ tenantId, jobId, phaseKey: "repair_work" }, deps as never);
    expect("sent" in res && res.sent).toBe(true);
    expect((res as { photoCount: number }).photoCount).toBe(2); // double-gated only

    expect(deps.ai.complete).toHaveBeenCalledOnce();
    expect(deps.sent[0]!.to).toBe("+16025551000");
    expect(deps.sent[0]!.body).toContain("Repair work's done");
    expect(deps.sent[0]!.body).toMatch(/\/b\/|\/status\//); // links to the status page story

    const [row] = await adminDb.select().from(productionUpdate).where(eq(productionUpdate.jobId, jobId));
    expect(row!.kind).toBe("phase_complete");
    expect(row!.sentAt).toBeInstanceOf(Date);
    expect(row!.photoIds).toHaveLength(2);
  });

  it("suppresses WITH a ledger row when no photo passes the double gate", async () => {
    const { tenantId, jobId } = await seedDoneVisiblePhase({ safePhotos: 0 });
    const deps = fakeDeps();

    const res = await sendPhaseCompleteUpdate({ tenantId, jobId, phaseKey: "repair_work" }, deps as never);
    expect(res).toMatchObject({ sent: false, suppressed: "no_safe_photos" });
    expect(deps.sent).toHaveLength(0);

    const [row] = await adminDb.select().from(productionUpdate).where(eq(productionUpdate.jobId, jobId));
    expect(row!.suppressedReason).toBe("no_safe_photos");
  });

  it("respects the max-N/day throttle (suppression logged, nothing sent)", async () => {
    const { tenantId, jobId } = await seedDoneVisiblePhase();
    const { recordProductionUpdate } = await import("@savvy/db");
    for (let i = 0; i < 3; i++) {
      await recordProductionUpdate({ tenantId, jobId, kind: "phase_complete", phaseKey: `x${i}`, sentAt: new Date() });
    }
    const deps = fakeDeps();
    const res = await sendPhaseCompleteUpdate({ tenantId, jobId, phaseKey: "repair_work" }, deps as never);
    expect(res).toMatchObject({ sent: false, suppressed: "throttle" });
    expect(deps.sent).toHaveLength(0);
  });

  it("opted-out homeowners suppress with a ledger row; a second call never double-logs the phase", async () => {
    const { tenantId, jobId } = await seedDoneVisiblePhase({ optOut: true });
    const deps = fakeDeps();
    await sendPhaseCompleteUpdate({ tenantId, jobId, phaseKey: "repair_work" }, deps as never);
    const replay = await sendPhaseCompleteUpdate({ tenantId, jobId, phaseKey: "repair_work" }, deps as never);
    expect(replay).toMatchObject({ sent: false, suppressed: "already_updated" });

    const rows = await adminDb.select().from(productionUpdate).where(eq(productionUpdate.jobId, jobId));
    expect(rows).toHaveLength(1);
  });

  it("drafts in the customer's language when set", async () => {
    const { tenantId, jobId } = await seedDoneVisiblePhase({ language: "es" });
    const deps = fakeDeps("La reparación quedó lista — todo sellado y firme.");
    await sendPhaseCompleteUpdate({ tenantId, jobId, phaseKey: "repair_work" }, deps as never);
    const call = (deps.ai.complete.mock.calls as unknown as [{ system: string }][])[0]![0];
    expect(call.system.toLowerCase()).toContain("spanish");
  });

  // Compliance follow-up: sendPhaseCompleteUpdate previously called
  // sender.sendSms directly, bypassing the global contact_suppression list.
  // Proves guardedSms is wired: a consented, non-opted-out homeowner who is
  // globally suppressed is NOT texted, and the ledger records the suppression
  // (never a false "sent").
  it("globally suppressed homeowner → not texted, suppression logged, gate closes once", async () => {
    const { tenantId, jobId } = await seedDoneVisiblePhase({ phone: "+16025559999" });
    await suppress({ tenantId, phoneE164: "+16025559999", channel: "sms", reason: "stop", source: "test" });
    const deps = fakeDeps();

    const res = await sendPhaseCompleteUpdate({ tenantId, jobId, phaseKey: "repair_work" }, deps as never);
    expect("sent" in res && res.sent).toBe(false);
    expect((res as { suppressed: string }).suppressed).toContain("guard_");
    expect(deps.sent).toHaveLength(0);

    const [row] = await adminDb.select().from(productionUpdate).where(eq(productionUpdate.jobId, jobId));
    expect(row!.suppressedReason).toContain("guard_");

    // Once-per-phase gate holds even for a guard-blocked send.
    const replay = await sendPhaseCompleteUpdate({ tenantId, jobId, phaseKey: "repair_work" }, deps as never);
    expect(replay).toMatchObject({ sent: false, suppressed: "already_updated" });
    const rows = await adminDb.select().from(productionUpdate).where(eq(productionUpdate.jobId, jobId));
    expect(rows).toHaveLength(1);
  });
});
