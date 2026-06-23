import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant } from "../src/schema/index.js";
import { eq } from "drizzle-orm";
import { addLeadSource, getCustomLeadSources } from "../src/lifecycle/lead-sources.js";

let tenantId: string;

beforeAll(async () => {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "T", clerkOrgId: `org_${Date.now()}`, settings: { onboarding: { done: true } } })
    .returning();
  tenantId = t!.id;
});

afterAll(async () => {
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("tenant lead sources", () => {
  it("appends a source and preserves sibling settings", async () => {
    const after = await addLeadSource(tenantId, "Home Show");
    expect(after).toContain("Home Show");
    const [t] = await adminDb
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    expect((t!.settings as any).onboarding.done).toBe(true);
    expect(await getCustomLeadSources(tenantId)).toContain("Home Show");
  });
  it("dedupes case-insensitively", async () => {
    await addLeadSource(tenantId, "Home Show");
    await addLeadSource(tenantId, "HOME SHOW");
    const list = await getCustomLeadSources(tenantId);
    expect(list.filter((s) => s.toLowerCase() === "home show").length).toBe(1);
  });
});
