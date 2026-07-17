import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  adminDb, tenant, customer, drip, messageTemplate, dripEnrollment, communication, eq, and,
} from "@savvy/db";
import { inngest } from "@savvy/agents";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 500));
  }
}

test("drip: enroll -> step 1 logs a communication -> inbound STOP stops it + opts out", async ({ request }) => {
  // The e2e tenant's inbound phone (the Twilio 'To') routes the inbound STOP.
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  const inboundPhone = t!.inboundPhone!;

  // A UNIQUE phone per attempt. The inbound webhook matches the customer by
  // `From` phone with an unordered first-row select, so a reused number lets a
  // leftover customer (a failed prior attempt of THIS test, or schedule.spec's
  // shared +15555557777 seeds) steal the STOP and the fresh enrollment never
  // stops (CI 2026-07-17, run 29555876651: attempt 1 died on ECONNRESET after
  // enrolling, retry's STOP matched attempt 1's customer and timed out at the
  // stop assertion). The +1556 prefix keeps it out of the +1555 range used by
  // tenant inbound numbers (create-tenant.ts) and other specs' fixed seeds.
  const stamp = randomUUID().slice(0, 8);
  const phone = `+1556${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

  // Seed a 2-STEP nurture drip for the e2e tenant if absent. Step 1 (delay 0) sends
  // immediately; step 2 (delay 1h) keeps the run SLEEPING so the enrollment stays
  // ACTIVE when STOP arrives. (A 1-step drip would reach 'completed' before STOP, and
  // stopDripEnrollments only touches 'active' rows -> the stop assertion would fail.)
  // onConflictDoNothing: both tables have unique (tenant_id, key) indexes, and a
  // prior attempt that died between the two inserts would otherwise 23505 the retry.
  const existing = await adminDb.select().from(drip).where(and(eq(drip.tenantId, tenantId), eq(drip.key, "nurture")));
  if (existing.length === 0) {
    await adminDb.insert(messageTemplate).values({
      tenantId, key: "nurture-sms-1", name: "n1", channel: "sms", body: "Hi {{firstName}}!",
    }).onConflictDoNothing();
    await adminDb.insert(drip).values({
      tenantId, key: "nurture", name: "Nurture", active: true,
      steps: [
        { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "nurture-sms-1" },
        { stepNum: 2, delayHours: 1, channel: "sms", templateKey: "nurture-sms-1" },
      ],
    }).onConflictDoNothing();
  }

  // A contact to enroll.
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Drip Dan ${stamp}`, phone }).returning();
  const customerId = c!.id;

  // Enroll -> dripRun creates the enrollment + sends step 1 (mock SMS, fail-soft, logs the comm).
  await inngest.send({ name: "drip/enroll", data: { tenantId, dripKey: "nurture", customerId } });

  // Step 1 logs an outbound communication with the rendered body.
  const comm = await waitFor(async () => {
    const rows = await adminDb.select().from(communication)
      .where(and(eq(communication.customerId, customerId), eq(communication.direction, "outbound")));
    return rows[0];
  });
  expect(comm.channel).toBe("sms");
  expect(comm.body).toBe("Hi Drip!");

  // The enrollment exists AND is active (the run's step-1 bookkeeping settled;
  // it now sleeps before step 2) — only then is stopDripEnrollments guaranteed
  // to see it, since it only touches 'active' rows.
  const enr = await waitFor(async () => {
    const rows = await adminDb.select().from(dripEnrollment).where(eq(dripEnrollment.customerId, customerId));
    return rows[0]?.status === "active" ? rows[0] : undefined;
  });

  // Inbound STOP via the REAL Twilio webhook route -> opt-out + stop. Next dev
  // under CI load occasionally drops the socket mid-request (read ECONNRESET,
  // CI 2026-07-17 run 29555876651 attempt 1), so retry transport errors — the
  // handler is idempotent (opt-out + stop of active enrollments).
  let res: Awaited<ReturnType<typeof request.post>> | undefined;
  for (let attempt = 1; !res; attempt++) {
    try {
      res = await request.post("/api/twilio/inbound", {
        form: { To: inboundPhone, From: phone, Body: "STOP", MessageSid: `SMe2e-${stamp}` },
      });
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  expect(res.ok()).toBeTruthy();

  // Enrollment becomes stopped/opted_out and the customer is opted out of SMS.
  await waitFor(async () => {
    const [row] = await adminDb.select().from(dripEnrollment).where(eq(dripEnrollment.id, enr.id));
    return row && row.status === "stopped" ? row : undefined;
  });
  const [stopped] = await adminDb.select().from(dripEnrollment).where(eq(dripEnrollment.id, enr.id));
  expect(stopped!.status).toBe("stopped");
  expect(stopped!.stoppedReason).toBe("opted_out");
  const [c2] = await adminDb.select().from(customer).where(eq(customer.id, customerId));
  expect(c2!.smsOptOut).toBe(true);
});
