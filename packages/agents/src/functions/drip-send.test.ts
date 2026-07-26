import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { REGISTRY_TASK } from "@savvy/core";
import {
  adminDb, adminPool, pool, eq, and,
  tenant, customer, lead, property, drip, dripEnrollment, communication, agentRun, taskRegistry, leadTask, suppress, contactSuppression,
} from "@savvy/db";
import { sendDripStep } from "./drip";

let tId: string, custId: string, dripId: string, enrId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "DS", publicKey: "ds", clerkOrgId: "org_ds" }).returning();
  tId = t!.id;
  // smsConsentAt: real intake auto-records consent the moment a phone is captured
  // (packages/db/src/lifecycle/lead-intake.ts) — these fixtures represent an
  // already-consented customer, matching that real-world path.
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Pat Owner", phone: "+15555551234", email: "pat@x.com", smsConsentAt: new Date("2026-01-01") }).returning();
  custId = c!.id;
  const [d] = await adminDb.insert(drip).values({ tenantId: tId, key: "k", name: "D", steps: [] }).returning();
  dripId = d!.id;
  const [e] = await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: custId, status: "active" }).returning();
  enrId = e!.id;
});

afterAll(async () => {
  await adminDb.delete(contactSuppression).where(eq(contactSuppression.tenantId, tId));
  await adminDb.delete(communication).where(eq(communication.tenantId, tId));
  await adminDb.delete(agentRun).where(eq(agentRun.tenantId, tId));
  await adminDb.delete(dripEnrollment).where(eq(dripEnrollment.tenantId, tId));
  await adminDb.delete(drip).where(eq(drip.tenantId, tId));
  await adminDb.delete(leadTask).where(eq(leadTask.tenantId, tId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("sendDripStep", () => {
  it("sends an SMS template step, logs a communication, advances current_step", async () => {
    const sms = { sendSms: vi.fn().mockResolvedValue({ sid: "sm-1" }) };
    const email = { sendEmail: vi.fn() };
    await sendDripStep(
      {
        tenantId: tId, enrollmentId: enrId, customerId: custId,
        step: { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "welcome" },
        templateBody: "Hi {{firstName}}!",
      },
      { sms, from: "+15550000000", email, ai: { complete: vi.fn() } as never },
    );
    expect(sms.sendSms).toHaveBeenCalledOnce();
    const comms = await adminDb.select().from(communication).where(eq(communication.customerId, custId));
    expect(comms.length).toBe(1);
    expect(comms[0]!.channel).toBe("sms");
    expect(comms[0]!.body).toBe("Hi Pat!");
    const [enr] = await adminDb.select().from(dripEnrollment).where(eq(dripEnrollment.id, enrId));
    expect(enr!.currentStep).toBe(1);
  });

  it("suppresses the send when the channel is opted out (logs nothing sent)", async () => {
    await adminDb.update(customer).set({ smsOptOut: true }).where(eq(customer.id, custId));
    const sms = { sendSms: vi.fn() };
    await sendDripStep(
      {
        tenantId: tId, enrollmentId: enrId, customerId: custId,
        step: { stepNum: 2, delayHours: 0, channel: "sms", templateKey: "welcome" },
        templateBody: "Hi again",
      },
      { sms, from: "+15550000000", email: { sendEmail: vi.fn() }, ai: { complete: vi.fn() } as never },
    );
    expect(sms.sendSms).not.toHaveBeenCalled();
    const comms = await adminDb.select().from(communication).where(eq(communication.customerId, custId));
    expect(comms.some((r) => r.body === "[suppressed: sms opt-out]")).toBe(true);
    const [enr] = await adminDb.select().from(dripEnrollment).where(eq(dripEnrollment.id, enrId));
    expect(enr!.currentStep).toBe(2);
  });

  it("suppresses when the contact has no address for the channel", async () => {
    const [c2] = await adminDb.insert(customer).values({ tenantId: tId, name: "No Phone" }).returning();
    const [e2] = await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: c2!.id, status: "active" }).returning();
    const sms = { sendSms: vi.fn() };
    const res = await sendDripStep(
      {
        tenantId: tId, enrollmentId: e2!.id, customerId: c2!.id,
        step: { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "welcome" },
        templateBody: "Hi {{firstName}}!",
      },
      { sms, from: "+15550000000", email: { sendEmail: vi.fn() }, ai: { complete: vi.fn() } as never },
    );
    expect(res.sent).toBe(false);
    expect(sms.sendSms).not.toHaveBeenCalled();
    const comms = await adminDb.select().from(communication).where(eq(communication.customerId, c2!.id));
    expect(comms.some((r) => r.body === "[suppressed: no sms address]")).toBe(true);
  });

  it("suppresses a marketing EMAIL step to an appended email (transactional-only)", async () => {
    const [c3] = await adminDb.insert(customer).values({ tenantId: tId, name: "Appended Al", email: "broker@x.com", emailSource: "appended" }).returning();
    const [e3] = await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: c3!.id, status: "active" }).returning();
    const email = { sendEmail: vi.fn() };
    const res = await sendDripStep(
      {
        tenantId: tId, enrollmentId: e3!.id, customerId: c3!.id,
        step: { stepNum: 1, delayHours: 0, channel: "email", templateKey: "welcome" },
        templateBody: "Hi {{firstName}}!",
      },
      { sms: { sendSms: vi.fn() }, from: "+15550000000", email, ai: { complete: vi.fn() } as never },
    );
    expect(res.sent).toBe(false);
    expect(email.sendEmail).not.toHaveBeenCalled();
    const comms = await adminDb.select().from(communication).where(eq(communication.customerId, c3!.id));
    expect(comms.some((r) => r.body === "[suppressed: appended email (transactional-only)]")).toBe(true);
  });

  it("throttled tenant: sendSms is NOT called, comm still logged with mock sid", async () => {
    // Reset smsOptOut from the earlier opt-out test.
    await adminDb.update(customer).set({ smsOptOut: false }).where(eq(customer.id, custId));
    const sms = { sendSms: vi.fn() };
    await sendDripStep(
      {
        tenantId: tId, enrollmentId: enrId, customerId: custId,
        step: { stepNum: 3, delayHours: 0, channel: "sms", templateKey: "welcome" },
        templateBody: "Hi {{firstName}}!",
      },
      {
        sms, from: "+15550000000", email: { sendEmail: vi.fn() }, ai: { complete: vi.fn() } as never,
        isThrottled: vi.fn().mockResolvedValue(true),
      },
    );
    expect(sms.sendSms).not.toHaveBeenCalled();
    const comms = await adminDb.select().from(communication).where(
      and(eq(communication.customerId, custId), eq(communication.twilioSid, "mock")),
    );
    // Comm row was inserted (fail-soft sentinel), step was advanced — pipeline intact.
    expect(comms.length).toBeGreaterThan(0);
  });

  it("healthy tenant: sendSms IS called when throttle check returns false", async () => {
    const [c4] = await adminDb.insert(customer).values({ tenantId: tId, name: "Healthy Owner", phone: "+15555558888", smsConsentAt: new Date("2026-01-01") }).returning();
    const [e4] = await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: c4!.id, status: "active" }).returning();
    const sms = { sendSms: vi.fn().mockResolvedValue({ sid: "sm-healthy" }) };
    await sendDripStep(
      {
        tenantId: tId, enrollmentId: e4!.id, customerId: c4!.id,
        step: { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "welcome" },
        templateBody: "Hello {{firstName}}!",
      },
      {
        sms, from: "+15550000000", email: { sendEmail: vi.fn() }, ai: { complete: vi.fn() } as never,
        isThrottled: vi.fn().mockResolvedValue(false),
      },
    );
    expect(sms.sendSms).toHaveBeenCalledOnce();
  });

  it("marks lead_task 24 (follow-up sequence) done with the communication ref when a leadId is present", async () => {
    const [c5] = await adminDb.insert(customer).values({ tenantId: tId, name: "Lead Owner", phone: "+15555559000", smsConsentAt: new Date("2026-01-01") }).returning();
    const [p5] = await adminDb.insert(property).values({ tenantId: tId, customerId: c5!.id, address: "5 Drip Ln" }).returning();
    const [l5] = await adminDb.insert(lead).values({ tenantId: tId, customerId: c5!.id, propertyId: p5!.id, status: "contacted" }).returning();
    const [e5] = await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: c5!.id, leadId: l5!.id, status: "active" }).returning();
    await adminDb.insert(taskRegistry).values({ id: REGISTRY_TASK.FOLLOW_UP_SEQUENCE, slug: `exectest.${REGISTRY_TASK.FOLLOW_UP_SEQUENCE}`, name: "follow-up", phase: 2, defaultOwner: "HUMAN", defaultMode: "full_auto", scope: "per_lead" }).onConflictDoNothing({ target: taskRegistry.id });
    await adminDb.insert(leadTask).values({ tenantId: tId, leadId: l5!.id, taskId: REGISTRY_TASK.FOLLOW_UP_SEQUENCE, status: "pending" });

    const sms = { sendSms: vi.fn().mockResolvedValue({ sid: "sm-lead" }) };
    await sendDripStep(
      {
        tenantId: tId, enrollmentId: e5!.id, customerId: c5!.id, leadId: l5!.id,
        step: { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "welcome" },
        templateBody: "Following up, {{firstName}}",
      },
      { sms, from: "+15550000000", email: { sendEmail: vi.fn() }, ai: { complete: vi.fn() } as never },
    );

    const [comm] = await adminDb.select().from(communication).where(and(eq(communication.customerId, c5!.id), eq(communication.direction, "outbound")));
    const [row] = await adminDb.select().from(leadTask).where(and(eq(leadTask.leadId, l5!.id), eq(leadTask.taskId, REGISTRY_TASK.FOLLOW_UP_SEQUENCE)));
    expect(row!.status).toBe("done");
    expect(row!.evidence).toEqual({ type: "communication", ref: comm!.id });
  });

  // Task 5 (Day 3 Slice A): drip.ts previously bypassed the global suppression
  // list entirely — a contact who had STOPped (contact_suppression) could still
  // receive a drip SMS because sendDripStep only checked per-customer
  // smsOptOut/address, never the shared @savvy/db isSuppressed() chokepoint.
  // This proves the bypass is closed: sendDripStep does NOT override
  // isSuppressed in its deps, so it exercises the real DB-backed check.
  it("does NOT call the sender when the contact is globally suppressed (compliance bypass closed)", async () => {
    const [c6] = await adminDb.insert(customer).values({
      tenantId: tId, name: "Suppressed Sam", phone: "+15555550001", smsConsentAt: new Date("2026-01-01"),
    }).returning();
    const [e6] = await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: c6!.id, status: "active" }).returning();
    await suppress({ tenantId: tId, phoneE164: "+15555550001", channel: "sms", reason: "stop", source: "test" });

    const sms = { sendSms: vi.fn() };
    const res = await sendDripStep(
      {
        tenantId: tId, enrollmentId: e6!.id, customerId: c6!.id,
        step: { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "welcome" },
        templateBody: "Hi {{firstName}}!",
      },
      { sms, from: "+15550000000", email: { sendEmail: vi.fn() }, ai: { complete: vi.fn() } as never },
    );

    expect(res.sent).toBe(false);
    expect(sms.sendSms).not.toHaveBeenCalled();
    const comms = await adminDb.select().from(communication).where(eq(communication.customerId, c6!.id));
    expect(comms.some((r) => r.body?.includes("blocked: suppressed"))).toBe(true);
  });

  // Fix-pass follow-up: a guardedSms throw (e.g. a transient isSuppressed DB
  // error) must NOT be recorded as a false-positive "sent" communication row.
  // Proves the narrowed catch in sendDripStep's SMS branch.
  it("records a failure (not a false-positive sent row) when isSuppressed rejects", async () => {
    const [c7] = await adminDb.insert(customer).values({
      tenantId: tId, name: "Flaky Fran", phone: "+15555550002", smsConsentAt: new Date("2026-01-01"),
    }).returning();
    const [e7] = await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: c7!.id, status: "active" }).returning();

    const sms = { sendSms: vi.fn().mockResolvedValue({ sid: "sm-should-not-fire" }) };
    const res = await sendDripStep(
      {
        tenantId: tId, enrollmentId: e7!.id, customerId: c7!.id,
        step: { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "welcome" },
        templateBody: "Hi {{firstName}}!",
      },
      {
        sms, from: "+15550000000", email: { sendEmail: vi.fn() }, ai: { complete: vi.fn() } as never,
        isSuppressed: vi.fn().mockRejectedValue(new Error("suppression lookup timed out")),
      },
    );

    expect(res.sent).toBe(false);
    expect(sms.sendSms).not.toHaveBeenCalled();
    const [comm] = await adminDb.select().from(communication).where(eq(communication.customerId, c7!.id));
    expect(comm!.body).toContain("error: suppression lookup timed out");
    // No false-positive sid — the row must NOT read as a successful send.
    expect(comm!.twilioSid).not.toBe("sm-should-not-fire");
    expect(comm!.twilioSid).not.toBe("mock");
  });
});
