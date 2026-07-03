import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { reconcileTaskExceptions } from "../src/index.js";
import {
  tenant, customer, property, job, taskRegistry, taskHealth, verificationRun, jobTask, invoice, taskException,
} from "../src/schema/index.js";

// Tasks: BIG/SMALL are done-but-wrong (verification_mismatch) with invoice evidence;
// COMMS is done-but-wrong but its evidence is not an invoice; STALE is task_stale.
const BIG = 9651, SMALL = 9652, COMMS = 9653, STALE = 9654;
const SYN = [BIG, SMALL, COMMS, STALE];
const MIN_DOLLARS = 1000; // break-glass threshold => 100_000 cents

let tenantId: string;
let jobId: string;

const reg = (id: number) => ({ id, slug: `bg.${id}`, name: `bg-${id}`, phase: 9, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const, checkKey: `test.${id}` });
const exRow = (taskId: number) => adminDb.select().from(taskException).where(and(eq(taskException.tenantId, tenantId), eq(taskException.taskId, taskId), isNull(taskException.resolvedAt))).then((r) => r[0]);

beforeAll(async () => {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "BG Co", publicKey: `bg-${Date.now()}`, clerkOrgId: `org_bg_${Date.now()}`, breakGlass: { min_dollars: MIN_DOLLARS, deadline_hours: 48 } })
    .returning();
  tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "HO" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" }).returning();
  jobId = j!.id;

  const [bigInv] = await adminDb.insert(invoice).values({ tenantId, jobId, amountDue: 250_00 * 10 }).returning(); // $2,500 -> above threshold
  const [smallInv] = await adminDb.insert(invoice).values({ tenantId, jobId, amountDue: 500_00 }).returning(); // $500 -> below threshold

  await adminDb.insert(taskRegistry).values(SYN.map(reg));
  // Done-but-wrong ledger rows (status='exception') carry the underlying $ impact.
  await adminDb.insert(jobTask).values([
    { tenantId, jobId, taskId: BIG, status: "exception", evidence: { type: "invoice", ref: bigInv!.id } },
    { tenantId, jobId, taskId: SMALL, status: "exception", evidence: { type: "invoice", ref: smallInv!.id } },
    { tenantId, jobId, taskId: COMMS, status: "exception", evidence: { type: "communication", ref: "not-an-invoice" } },
  ]);
  await adminDb.insert(taskHealth).values([
    { tenantId, taskId: BIG, status: "red", effectiveMode: "full_auto", openExceptionCount: 1 },
    { tenantId, taskId: SMALL, status: "red", effectiveMode: "full_auto", openExceptionCount: 1 },
    { tenantId, taskId: COMMS, status: "red", effectiveMode: "full_auto", openExceptionCount: 1 },
    { tenantId, taskId: STALE, status: "amber", effectiveMode: "full_auto", openExceptionCount: 0 },
  ]);
  await adminDb.insert(verificationRun).values([
    { tenantId, taskId: BIG, checkKey: "test.9601", status: "fail" },
    { tenantId, taskId: SMALL, checkKey: "test.9602", status: "fail" },
    { tenantId, taskId: COMMS, checkKey: "test.9603", status: "fail" },
    { tenantId, taskId: STALE, checkKey: "test.9604", status: "stale" },
  ]);
});

afterAll(async () => {
  await adminDb.delete(taskException).where(eq(taskException.tenantId, tenantId));
  await adminDb.delete(jobTask).where(eq(jobTask.tenantId, tenantId));
  await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(invoice).where(eq(invoice.tenantId, tenantId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId)); // cascades any remaining job_task
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  // Registry rows LAST — after every job_task that could reference them is gone
  // (the explicit delete above + the job cascade), so a concurrent run can't FK-fail here.
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("reconcileTaskExceptions — dollar impact + break_glass", () => {
  it("sums invoice evidence for a done-but-wrong task and flags break_glass above the threshold", async () => {
    await reconcileTaskExceptions(tenantId);
    const big = await exRow(BIG);
    expect(big!.kind).toBe("verification_mismatch");
    expect(big!.dollarImpactCents).toBe(250_00 * 10); // the invoice's amount_due
    expect(big!.breakGlass).toBe(true); // $2,500 >= $1,000
  });

  it("computes dollar impact but does NOT break-glass below the threshold", async () => {
    const small = await exRow(SMALL);
    expect(small!.dollarImpactCents).toBe(500_00);
    expect(small!.breakGlass).toBe(false); // $500 < $1,000
  });

  it("ignores non-invoice evidence (dollar impact 0, no break-glass)", async () => {
    const comms = await exRow(COMMS);
    expect(comms!.kind).toBe("verification_mismatch");
    expect(comms!.dollarImpactCents).toBe(0);
    expect(comms!.breakGlass).toBe(false);
  });

  it("leaves non-mismatch kinds at zero dollars (a stale task carries no $ impact)", async () => {
    const stale = await exRow(STALE);
    expect(stale!.kind).toBe("task_stale");
    expect(stale!.dollarImpactCents).toBe(0);
    expect(stale!.breakGlass).toBe(false);
  });

  it("refreshes dollar impact + break_glass idempotently on re-run", async () => {
    const before = await exRow(BIG);
    await reconcileTaskExceptions(tenantId);
    const after = await exRow(BIG);
    expect(after!.id).toBe(before!.id); // same open row
    expect(after!.dollarImpactCents).toBe(250_00 * 10);
    expect(after!.breakGlass).toBe(true);
  });
});
