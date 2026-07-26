import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, lead, repairCredit, relationshipTouch, suppress, eq, and, sql, issueRepairCredit } from "@savvy/db";
import { sweepTenantRepairCredits } from "./repair-credit-sweep.js";

async function seedCreditAt12mo(opts: { optOut?: boolean; phone?: string } = {}) {
  const [t] = await adminDb.insert(tenant).values({
    name: "CreditSweep", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    settings: { homeowner: { quietHours: { startHour: 0, endHour: 0 } } } as never, // deterministic at any hour
  }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({
    tenantId, name: "Casey Credit", phone: opts.phone ?? "+16025550777", smsOptOut: opts.optOut ?? false,
    smsConsentAt: new Date("2026-01-01"),
  }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "4 Credit Ct" }).returning();
  await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "web" });

  const issued = await issueRepairCredit({ tenantId, customerId: c!.id, sourceInvoiceRef: "inv-sweep", amountCents: 25000 });
  const creditId = (issued as { creditId: string }).creditId;
  await adminDb.update(repairCredit).set({ issuedAt: sql`now() - interval '380 days'`, expiresAt: sql`now() + interval '700 days'` })
    .where(eq(repairCredit.id, creditId));
  return { tenantId, creditId, custId: c!.id };
}

function fakeSmsDeps() {
  const sent: { to: string; body: string }[] = [];
  return {
    sent,
    getTenantSms: (async () => ({
      sender: { sendSms: async (m: { to: string; body: string }) => { sent.push(m); return { providerId: "fake" }; } },
      from: "+15555550000",
    })) as never,
  };
}

describe("sweepTenantRepairCredits", () => {
  it("sends the 12mo service touch once, logs it, and never re-sends", async () => {
    const { tenantId, creditId } = await seedCreditAt12mo();
    const deps = fakeSmsDeps();

    const first = await sweepTenantRepairCredits(tenantId, deps as never);
    expect(first.touched).toBe(1);
    expect(deps.sent[0]!.to).toBe("+16025550777");
    expect(deps.sent[0]!.body).toContain("$250");
    expect(deps.sent[0]!.body).toContain("Casey");
    expect(deps.sent[0]!.body).not.toMatch(/act now|last chance|urgent/i); // service framing, never pressure

    const again = await sweepTenantRepairCredits(tenantId, deps as never);
    expect(again.touched).toBe(0);

    const [row] = await adminDb.select().from(repairCredit).where(eq(repairCredit.id, creditId));
    expect((row!.checkinLog as { kind: string }[]).map((l) => l.kind)).toEqual(["12mo"]);

    // Customer for Life: the send rode the relationship calendar (governor).
    const { relationshipTouch } = await import("@savvy/db");
    const touches = await adminDb.select().from(relationshipTouch)
      .where(eq(relationshipTouch.sourceRef, `${creditId}:12mo`));
    expect(touches).toHaveLength(1);
    expect(touches[0]!.program).toBe("credit_checkin");
    expect(touches[0]!.sentAt).toBeInstanceOf(Date);
  });

  it("an opted-out customer still logs the check-in as suppressed (cadence ran)", async () => {
    const { tenantId, creditId } = await seedCreditAt12mo({ optOut: true });
    const deps = fakeSmsDeps();

    const res = await sweepTenantRepairCredits(tenantId, deps as never);
    expect(res.touched).toBe(0);
    expect(deps.sent).toHaveLength(0);
    const [row] = await adminDb.select().from(repairCredit).where(eq(repairCredit.id, creditId));
    expect((row!.checkinLog as { kind: string }[]).map((l) => l.kind)).toEqual(["12mo"]);

    // Customer for Life: the opt-out was honored AT the governor — the calendar
    // row is a logged suppression, and nothing was sent.
    const { relationshipTouch } = await import("@savvy/db");
    const touches = await adminDb.select().from(relationshipTouch)
      .where(eq(relationshipTouch.sourceRef, `${creditId}:12mo`));
    expect(touches).toHaveLength(1);
    expect(touches[0]!.suppressedReason).toBe("opt_out");
    expect(touches[0]!.sentAt).toBeNull();
  });

  it("quiet hours suppress touches but the expiry sweep still runs", async () => {
    const { tenantId, creditId } = await seedCreditAt12mo();
    await adminDb.update(tenant).set({
      settings: { homeowner: { quietHours: { startHour: 21, endHour: 8 } } } as never,
    }).where(eq(tenant.id, tenantId));
    await adminDb.update(repairCredit).set({ expiresAt: sql`now() - interval '2 days'` }).where(eq(repairCredit.id, creditId));

    // Pin "now" to 02:00 UTC — deterministically inside the 21→8 window
    // (tenant tz defaults UTC) at any real wall-clock hour.
    const quietNow = new Date(); quietNow.setUTCHours(2, 0, 0, 0);
    const deps = { ...fakeSmsDeps(), now: () => quietNow };
    const res = await sweepTenantRepairCredits(tenantId, deps as never);
    expect(res.touched).toBe(0);
    expect(res.expired).toBe(1);
    expect(deps.sent).toHaveLength(0);
  });

  // Compliance follow-up: sweepTenantRepairCredits called sender.sendSms
  // directly, bypassing the global contact_suppression list. Proves
  // guardedSms is wired: a consented, non-opted-out customer who is globally
  // suppressed is NOT texted, and their relationship-calendar touch stays
  // unsent (never flips to sent).
  it("globally suppressed customer → not texted, touch stays unsent (compliance bypass closed)", async () => {
    const { tenantId, creditId, custId } = await seedCreditAt12mo({ phone: "+16025550444" });
    await suppress({ tenantId, phoneE164: "+16025550444", channel: "sms", reason: "stop", source: "test" });
    const deps = fakeSmsDeps();

    const res = await sweepTenantRepairCredits(tenantId, deps as never);
    expect(res.touched).toBe(0);
    expect(deps.sent).toHaveLength(0);

    const [row] = await adminDb.select().from(repairCredit).where(eq(repairCredit.id, creditId));
    expect((row!.checkinLog as { kind: string }[]).map((l) => l.kind)).toEqual(["12mo"]);

    const touches = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.customerId, custId), eq(relationshipTouch.sourceRef, `${creditId}:12mo`)));
    expect(touches).toHaveLength(1);
    expect(touches[0]!.sentAt).toBeNull();
    // Admitted by the governor (opt-out is false) — the block came from the
    // global suppression list inside guardedSms, not the governor.
    expect(touches[0]!.suppressedReason).toBeNull();
  });
});
