import { describe, it, expect } from "vitest";
import { dunningSchedule, type DunningStep } from "@savvy/core";
import { adminDb, withTenant, eq, tenant, customer, property, job, invoice, communication, suppress } from "@savvy/db";
import { sendDunningStep } from "./dunning";

describe("dunning sequencing", () => {
  it("schedule is ascending and ends on the SMS escalation day", () => {
    const steps = dunningSchedule({ smsEscalationDay: 21 });
    const offsets = steps.map((s) => s.dayOffset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets); // already ascending
    const last = steps.at(-1);
    expect(last?.channel).toBe("sms");
    expect(last?.dayOffset).toBe(21);
    expect(last?.flipsOverdue).toBe(true);
  });

  it("only the final step escalates to SMS / flips overdue", () => {
    const steps = dunningSchedule({ smsEscalationDay: 30 });
    const emailSteps = steps.slice(0, -1);
    expect(emailSteps.every((s) => s.channel === "email" && !s.flipsOverdue)).toBe(true);
  });
});

// Compliance follow-up: the SMS escalation step previously called
// sender.sendSms directly, bypassing the global contact_suppression list, and
// swallowed thrown errors as a fail-soft "sent" (logging a mock sid). Both
// are wrong: a real send must go through guardedSms, and a THROW must never
// be recorded as a successful dunning send.
const SMS_STEP: DunningStep = { stepNum: 4, dayOffset: 21, channel: "sms", tone: "final", flipsOverdue: true };

async function seedOverdueInvoice(custOverrides: Partial<typeof customer.$inferInsert> = {}) {
  const [t] = await adminDb.insert(tenant).values({
    name: "Dunning", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({
    tenantId, name: "Owes Money", phone: "+16025550100", smsConsentAt: new Date("2026-01-01"), ...custOverrides,
  }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Overdue Ave" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" }).returning();
  const [inv] = await adminDb.insert(invoice).values({
    tenantId, jobId: j!.id, customerId: c!.id, number: "INV-1", status: "sent", amountDue: 50000, dueAt: new Date(),
  }).returning();
  return { tenantId, invoiceId: inv!.id, jobId: j!.id, phone: c!.phone as string };
}

function fakeSmsDeps() {
  const sent: { to: string; body: string }[] = [];
  return {
    sent,
    getTenantSms: (async () => ({
      sender: { sendSms: async (m: { to: string; body: string }) => { sent.push(m); return { sid: "SM-mock" }; } },
      from: "+15555550000",
    })) as never,
    getTenantEmail: (async () => ({ sendEmail: async () => ({ id: "mock" }) })) as never,
  };
}

describe("sendDunningStep — SMS escalation routed through guardedSms", () => {
  it("sends the SMS escalation to a consented, reachable customer and logs the twilioSid", async () => {
    const { tenantId, invoiceId, jobId, phone } = await seedOverdueInvoice();
    const deps = fakeSmsDeps();

    const res = await sendDunningStep({ tenantId, invoiceId, step: SMS_STEP, gmailConnectionId: null }, deps);
    expect(res).toEqual({ completed: true });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.to).toBe(phone);

    const [row] = await withTenant(tenantId, (tx) => tx.select().from(communication).where(eq(communication.jobId, jobId)));
    expect(row!.twilioSid).toBe("SM-mock");
    expect(row!.body).not.toContain("suppressed");

    const [inv] = await withTenant(tenantId, (tx) => tx.select().from(invoice).where(eq(invoice.id, invoiceId)));
    expect(inv!.status).toBe("overdue");
  });

  // Proves guardedSms is wired: a consented, non-opted-out customer who is
  // globally suppressed is NOT texted, and no sid is logged as if it sent.
  it("globally suppressed customer → not texted, communication logged as suppressed (no sid)", async () => {
    const { tenantId, invoiceId, jobId } = await seedOverdueInvoice({ phone: "+16025551111" });
    await suppress({ tenantId, phoneE164: "+16025551111", channel: "sms", reason: "stop", source: "test" });
    const deps = fakeSmsDeps();

    const res = await sendDunningStep({ tenantId, invoiceId, step: SMS_STEP, gmailConnectionId: null }, deps);
    expect(res).toEqual({ completed: true });
    expect(deps.sent).toHaveLength(0);

    const [row] = await withTenant(tenantId, (tx) => tx.select().from(communication).where(eq(communication.jobId, jobId)));
    expect(row!.body).toContain("suppressed");
    expect(row!.body).toContain("guard_");
    expect(row!.twilioSid).toBeNull();

    // Invoice still flips to overdue — that's independent of send outcome.
    const [inv] = await withTenant(tenantId, (tx) => tx.select().from(invoice).where(eq(invoice.id, invoiceId)));
    expect(inv!.status).toBe("overdue");
  });

  // Review follow-up: a THROWN error (transient DB blip / provider 5xx) must
  // NOT be caught and logged as a fail-soft "sent" with a mock sid — it must
  // propagate so the Inngest step retries instead of silently recording a
  // dunning message that never actually sent.
  it("guardedSms throw propagates — no communication row is logged as sent", async () => {
    const { tenantId, invoiceId, jobId } = await seedOverdueInvoice({ phone: "+16025552222" });
    const throwingDeps = {
      getTenantSms: (async () => { throw new Error("provider 5xx"); }) as never,
      getTenantEmail: (async () => ({ sendEmail: async () => ({ id: "mock" }) })) as never,
    };

    await expect(sendDunningStep({ tenantId, invoiceId, step: SMS_STEP, gmailConnectionId: null }, throwingDeps))
      .rejects.toThrow("provider 5xx");

    const rows = await withTenant(tenantId, (tx) => tx.select().from(communication).where(eq(communication.jobId, jobId)));
    expect(rows).toHaveLength(0);
  });
});
