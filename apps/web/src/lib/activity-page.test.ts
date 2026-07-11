// CI-gated: requires Postgres. If ECONNREFUSED locally, this suite is expected
// to fail — rely on CI. Mirrors the tenant-seeding + TEST_MODE pattern used by
// intake.test.ts (adminDb-seeded tenant + a getTenantId-based function).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminDb, tenant, recordAgentRun } from "@savvy/db";
import { loadActivityPage } from "./command-center-queries";

describe("loadActivityPage", () => {
  let tenantId: string;
  const prevTestMode = process.env.TEST_MODE;
  const prevTestTenantId = process.env.TEST_TENANT_ID;

  beforeAll(async () => {
    const [t] = await adminDb
      .insert(tenant)
      .values({ name: "ActivityPageTest", clerkOrgId: `org_activity_page_${Date.now()}` })
      .returning();
    tenantId = t!.id;
    process.env.TEST_MODE = "1";
    process.env.TEST_TENANT_ID = tenantId;

    await recordAgentRun({
      tenantId, agent: "comms", taskKey: "drip.append", status: "ok",
    });
    await recordAgentRun({
      tenantId, agent: "finance", taskKey: "finance.dunning", status: "ok",
    });
  });

  afterAll(() => {
    process.env.TEST_MODE = prevTestMode;
    process.env.TEST_TENANT_ID = prevTestTenantId;
  });

  it("returns feed rows with a plain-words verb + a nextCursor when full", async () => {
    const { rows, nextCursor } = await loadActivityPage({ limit: 5 });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(typeof r.verb).toBe("string");
    expect(nextCursor === null || typeof nextCursor === "string").toBe(true);
  });

  it("sets nextCursor to the last row's startedAt ISO string when the page is full", async () => {
    const { rows, nextCursor } = await loadActivityPage({ limit: 2 });
    expect(rows).toHaveLength(2);
    expect(nextCursor).toBe(rows[rows.length - 1]!.startedAt.toISOString());
  });
});
