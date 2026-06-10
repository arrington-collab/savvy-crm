import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  adminDb, adminPool, pool, withTenant, eq,
  tenant, customer, drip, dripEnrollment, communication, agentRun,
} from "@savvy/db";
import { sendDripStep } from "./drip";

let tId: string, custId: string, dripId: string, enrId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "DS", publicKey: "ds", clerkOrgId: "org_ds" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Pat Owner", phone: "+15555551234", email: "pat@x.com" }).returning();
  custId = c!.id;
  const [d] = await adminDb.insert(drip).values({ tenantId: tId, key: "k", name: "D", steps: [] }).returning();
  dripId = d!.id;
  const [e] = await adminDb.insert(dripEnrollment).values({ tenantId: tId, dripId, customerId: custId, status: "active" }).returning();
  enrId = e!.id;
});

afterAll(async () => {
  await adminDb.delete(communication).where(eq(communication.tenantId, tId));
  await adminDb.delete(agentRun).where(eq(agentRun.tenantId, tId));
  await adminDb.delete(dripEnrollment).where(eq(dripEnrollment.tenantId, tId));
  await adminDb.delete(drip).where(eq(drip.tenantId, tId));
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
      { sms, email, ai: { complete: vi.fn() } as never },
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
      { sms, email: { sendEmail: vi.fn() }, ai: { complete: vi.fn() } as never },
    );
    expect(sms.sendSms).not.toHaveBeenCalled();
  });
});
