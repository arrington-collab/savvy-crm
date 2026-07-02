import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { REGISTRY_TASK } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { createInvoice, sendInvoice, setEstimateStatus, bookLeadSlot } from "../src/index.js";
import { tenant, user, customer, property, lead, job, estimate, taskRegistry, jobTask, leadTask } from "../src/schema/index.js";

// Execution points write ledger evidence when they run. Each test pre-creates the
// pending ledger row directly (bypassing instantiation), runs the real lifecycle
// function, and asserts it flipped to done with the right evidence ref.

let tenantId: string;
let repId: string;

const ensureTask = (id: number, scope: "per_job" | "per_lead") =>
  adminDb.insert(taskRegistry)
    .values({ id, slug: `exectest.${id}`, name: `exec-${id}`, phase: 9, defaultOwner: "HUMAN", defaultMode: "full_auto", scope })
    .onConflictDoNothing({ target: taskRegistry.id });

const mkJob = async () => {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "HO" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `a-${Date.now()}-${Math.random()}` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" }).returning();
  return { jobId: j!.id, customerId: c!.id };
};
const jt = (jobId: string, taskId: number) => adminDb.select().from(jobTask).where(and(eq(jobTask.jobId, jobId), eq(jobTask.taskId, taskId))).then((r) => r[0]);
const lt = (leadId: string, taskId: number) => adminDb.select().from(leadTask).where(and(eq(leadTask.leadId, leadId), eq(leadTask.taskId, taskId))).then((r) => r[0]);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "ExecEv Co", publicKey: `exec-${Date.now()}`, clerkOrgId: `org_exec_${Date.now()}`, stripeAccountId: "acct_test" }).returning();
  tenantId = t!.id;
  const [u] = await adminDb.insert(user).values({ tenantId, role: "rep", name: "Rep", email: `rep-${Date.now()}@x.com` }).returning();
  repId = u!.id;
  await ensureTask(REGISTRY_TASK.APPOINTMENT_SCHEDULING, "per_lead");
  await ensureTask(REGISTRY_TASK.ESTIMATE_DELIVERY, "per_job");
  await ensureTask(REGISTRY_TASK.INVOICE_GENERATION, "per_job");
  await ensureTask(REGISTRY_TASK.INVOICE_DELIVERY, "per_job");
});

afterAll(async () => {
  await adminPool.end();
});

describe("invoice execution points", () => {
  it("createInvoice marks job_task 139 (invoice generation) done with the invoice ref", async () => {
    const { jobId } = await mkJob();
    await adminDb.insert(jobTask).values({ tenantId, jobId, taskId: REGISTRY_TASK.INVOICE_GENERATION, status: "pending" });
    const inv = await createInvoice({ tenantId, jobId, lineItems: [{ description: "Roof", qty: 1, unitAmountCents: 100 }] });
    const row = await jt(jobId, REGISTRY_TASK.INVOICE_GENERATION);
    expect(row!.status).toBe("done");
    expect(row!.evidence).toEqual({ type: "invoice", ref: inv.id });
    expect(row!.completedAt).not.toBeNull();
  });

  it("sendInvoice marks job_task 140 (invoice delivery) done", async () => {
    const { jobId } = await mkJob();
    const inv = await createInvoice({ tenantId, jobId, lineItems: [{ description: "Roof", qty: 1, unitAmountCents: 100 }] });
    await adminDb.insert(jobTask).values({ tenantId, jobId, taskId: REGISTRY_TASK.INVOICE_DELIVERY, status: "pending" });
    await sendInvoice({ tenantId, invoiceId: inv.id });
    const row = await jt(jobId, REGISTRY_TASK.INVOICE_DELIVERY);
    expect(row!.status).toBe("done");
    expect(row!.evidence).toEqual({ type: "invoice", ref: inv.id });
  });
});

describe("estimate execution point", () => {
  it("setEstimateStatus('sent') marks job_task 56 (estimate delivery) done", async () => {
    const { jobId } = await mkJob();
    const [est] = await adminDb.insert(estimate).values({ tenantId, jobId, source: "manual", status: "draft", lineItems: [], total: 500 }).returning();
    await adminDb.insert(jobTask).values({ tenantId, jobId, taskId: REGISTRY_TASK.ESTIMATE_DELIVERY, status: "pending" });
    await setEstimateStatus({ tenantId, estimateId: est!.id, status: "sent" });
    const row = await jt(jobId, REGISTRY_TASK.ESTIMATE_DELIVERY);
    expect(row!.status).toBe("done");
    expect(row!.evidence).toEqual({ type: "estimate", ref: est!.id });
  });

  it("setEstimateStatus('draft') does NOT mark the delivery task", async () => {
    const { jobId } = await mkJob();
    const [est] = await adminDb.insert(estimate).values({ tenantId, jobId, source: "manual", status: "draft", lineItems: [] }).returning();
    await adminDb.insert(jobTask).values({ tenantId, jobId, taskId: REGISTRY_TASK.ESTIMATE_DELIVERY, status: "pending" });
    await setEstimateStatus({ tenantId, estimateId: est!.id, status: "draft" });
    const row = await jt(jobId, REGISTRY_TASK.ESTIMATE_DELIVERY);
    expect(row!.status).toBe("pending");
  });
});

describe("booking execution point", () => {
  it("bookLeadSlot marks lead_task 25 (appointment scheduling) done with the appointment ref", async () => {
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Booker", phone: "+16025550123" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `b-${Date.now()}` }).returning();
    const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", assignedUserId: repId }).returning();
    await adminDb.insert(leadTask).values({ tenantId, leadId: l!.id, taskId: REGISTRY_TASK.APPOINTMENT_SCHEDULING, status: "pending" });

    const start = new Date(Date.now() + 86_400_000).toISOString();
    const end = new Date(Date.now() + 86_400_000 + 3_600_000).toISOString();
    const res = await bookLeadSlot({ leadId: l!.id, startsAt: start, endsAt: end });
    expect("appointmentId" in res).toBe(true);

    const row = await lt(l!.id, REGISTRY_TASK.APPOINTMENT_SCHEDULING);
    expect(row!.status).toBe("done");
    expect(row!.evidence).toEqual({ type: "appointment", ref: (res as { appointmentId: string }).appointmentId });
  });
});
