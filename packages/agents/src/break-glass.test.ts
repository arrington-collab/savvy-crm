import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  adminDb, eq, and, inArray, isNull,
  tenant, user, taskRegistry, taskException, agentRun,
} from "@savvy/db";
import { pageBreakGlass } from "./break-glass";

const T = 9801; // a task whose exception is break-glass severity
let pagedT: string; // tenant with an unnotified break-glass exception
let quietT: string; // tenant whose exception is below break-glass

const reg = { id: T, slug: `bg.${T}`, name: "Invoice generation", phase: 9, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const, checkKey: `test.${T}`, estFounderMinutes: "15" };

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "BG-page", publicKey: `bgp-${Date.now()}`, clerkOrgId: `org_bgp_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "BG-quiet", publicKey: `bgq-${Date.now()}`, clerkOrgId: `org_bgq_${Date.now()}` }).returning();
  pagedT = a!.id; quietT = b!.id;
  await adminDb.insert(taskRegistry).values(reg).onConflictDoNothing({ target: taskRegistry.id });
  await adminDb.insert(user).values([
    { tenantId: pagedT, role: "owner", name: "Owner A", email: `owner-bgp-${Date.now()}@x.com`, phone: "+16025553333" },
    { tenantId: quietT, role: "owner", name: "Owner B", email: `owner-bgq-${Date.now()}@x.com`, phone: "+16025554444" },
  ]);
  await adminDb.insert(taskException).values([
    // Open, break-glass, not yet notified -> should page.
    { tenantId: pagedT, taskId: T, kind: "verification_mismatch", severity: "high", dollarImpactCents: 250_000, breakGlass: true },
    // Below the threshold -> never pages.
    { tenantId: quietT, taskId: T, kind: "verification_mismatch", severity: "high", dollarImpactCents: 5_000, breakGlass: false },
  ]);
});

afterAll(async () => {
  for (const tid of [pagedT, quietT]) {
    await adminDb.delete(taskException).where(eq(taskException.tenantId, tid));
    await adminDb.delete(agentRun).where(eq(agentRun.tenantId, tid));
    await adminDb.delete(user).where(eq(user.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, [T]));
});

const openUnnotified = (tid: string) =>
  adminDb.select().from(taskException).where(and(eq(taskException.tenantId, tid), eq(taskException.breakGlass, true), isNull(taskException.breakGlassNotifiedAt), isNull(taskException.resolvedAt)));

describe("pageBreakGlass", () => {
  it("pages the owner immediately, stamps notified_at, and records an agent_run", async () => {
    const sms = { sender: { sendSms: vi.fn().mockResolvedValue({ sid: "sm-bg" }) }, from: "+15550000000" };
    const r = await pageBreakGlass(pagedT, { sms, email: { sendEmail: vi.fn() } });
    expect(r.paged).toBe(1);
    expect(sms.sender.sendSms).toHaveBeenCalledOnce();
    expect(sms.sender.sendSms.mock.calls[0]![0].to).toBe("+16025553333");
    expect(sms.sender.sendSms.mock.calls[0]![0].body).toContain("break-glass");
    expect(sms.sender.sendSms.mock.calls[0]![0].body).toContain("$2,500");
    const runs = await adminDb.select().from(agentRun).where(and(eq(agentRun.tenantId, pagedT), eq(agentRun.taskKey, "ops.break_glass")));
    expect(runs.length).toBe(1);
    expect(await openUnnotified(pagedT)).toHaveLength(0); // stamped -> no longer unnotified
  });

  it("does not re-page an exception already notified (idempotent paging)", async () => {
    const sms = { sender: { sendSms: vi.fn() }, from: "+15550000000" };
    const r = await pageBreakGlass(pagedT, { sms, email: { sendEmail: vi.fn() } });
    expect(r.paged).toBe(0);
    expect(sms.sender.sendSms).not.toHaveBeenCalled();
  });

  it("pages nothing when no exception clears the break-glass threshold", async () => {
    const sms = { sender: { sendSms: vi.fn() }, from: "+15550000000" };
    const r = await pageBreakGlass(quietT, { sms, email: { sendEmail: vi.fn() } });
    expect(r.paged).toBe(0);
    expect(sms.sender.sendSms).not.toHaveBeenCalled();
  });
});
