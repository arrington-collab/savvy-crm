import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, job, lead } from "../src/schema/index.js";

// Runs the ACTUAL 0059 backfill SQL (not a hand-copied duplicate) against seeded
// tenants and asserts the P0 fix: existing tenants with real work get
// onboarding.requiredCompletedAt; empty tenants stay gated; already-completed
// tenants are untouched; sibling settings keys are preserved; re-running is a no-op.
const here = dirname(fileURLToPath(import.meta.url));
const BACKFILL_SQL = readFileSync(join(here, "..", "drizzle", "0059_onboarding_backfill.sql"), "utf8");

const requiredAt = (settings: unknown): string | null => {
  const s = settings as { onboarding?: { requiredCompletedAt?: string | null } } | null;
  return s?.onboarding?.requiredCompletedAt ?? null;
};
const read = async (id: string) => {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, id));
  return t!.settings as Record<string, unknown>;
};

let lockedByJobId: string; // has a job, null flag + a sibling settings key -> gets backfilled
let lockedByLeadId: string; // has a lead, null flag -> gets backfilled
let emptyId: string; // no work, null flag -> stays gated
let completedId: string; // has a job, flag already set -> untouched
const PRE_COMPLETED_AT = "2020-01-01T00:00:00.000Z";

beforeAll(async () => {
  const mk = async (label: string, settings: Record<string, unknown>) => {
    const [t] = await adminDb
      .insert(tenant)
      .values({ name: `BF-${label}`, publicKey: `bf-${label}-${Date.now()}`, clerkOrgId: `org_bf_${label}_${Date.now()}`, settings: settings as never })
      .returning();
    return t!.id;
  };
  const giveJob = async (tid: string) => {
    const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "bf" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `bf-${tid}` }).returning();
    await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id });
  };

  lockedByJobId = await mk("lockedjob", { finance: { timezone: "America/New_York" } });
  lockedByLeadId = await mk("lockedlead", {});
  emptyId = await mk("empty", {});
  completedId = await mk("done", { onboarding: { requiredCompletedAt: PRE_COMPLETED_AT, dismissed: true } });

  await giveJob(lockedByJobId);
  await giveJob(completedId);
  const [lc] = await adminDb.insert(customer).values({ tenantId: lockedByLeadId, name: "bf-lead" }).returning();
  await adminDb.insert(lead).values({ tenantId: lockedByLeadId, customerId: lc!.id, source: "test", status: "new" });
});

afterAll(async () => {
  for (const tid of [lockedByJobId, lockedByLeadId, emptyId, completedId]) {
    await adminDb.delete(job).where(eq(job.tenantId, tid));
    await adminDb.delete(lead).where(eq(lead.tenantId, tid));
    await adminDb.delete(property).where(eq(property.tenantId, tid));
    await adminDb.delete(customer).where(eq(customer.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminPool.end();
});

describe("0059 onboarding backfill migration", () => {
  it("backfills tenants with real work and leaves empty/completed tenants correct", async () => {
    await adminPool.query(BACKFILL_SQL);

    // Tenant with a job + null flag -> now completed, sibling key preserved.
    const lj = await read(lockedByJobId);
    expect(requiredAt(lj)).not.toBeNull();
    expect((lj.finance as { timezone?: string })?.timezone).toBe("America/New_York");

    // Tenant with only a lead + null flag -> now completed.
    expect(requiredAt(await read(lockedByLeadId))).not.toBeNull();

    // Genuinely empty tenant -> still gated (correct: still onboarding).
    expect(requiredAt(await read(emptyId))).toBeNull();

    // Already-completed tenant -> untouched (original timestamp + dismissed kept).
    const done = await read(completedId);
    expect(requiredAt(done)).toBe(PRE_COMPLETED_AT);
    expect((done.onboarding as { dismissed?: boolean }).dismissed).toBe(true);
  });

  it("is idempotent: a second run does not change already-backfilled timestamps", async () => {
    const before = requiredAt(await read(lockedByJobId));
    await adminPool.query(BACKFILL_SQL);
    expect(requiredAt(await read(lockedByJobId))).toBe(before);
    expect(requiredAt(await read(emptyId))).toBeNull();
  });
});
