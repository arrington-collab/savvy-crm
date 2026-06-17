import { describe, it, expect } from "vitest";
import { adminDb, eq, tenant, agentRun } from "@savvy/db";
import { draftChangeOrderScope } from "./change-order-draft";

async function seedTenant() {
  const [t] = await adminDb.insert(tenant).values({
    name: "AID", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  return t!.id;
}

const fakeAi = {
  completeObject: async () => ({
    object: { items: [{ key: "pipe-boots", quantity: 3 }, { key: "nonexistent", quantity: 1 }], summary: "added boots" },
    model: "claude-sonnet-stub",
  }),
};

describe("draftChangeOrderScope", () => {
  it("resolves price-book keys to priced line items, drops unknown keys, logs finance/ai-draft", async () => {
    const tenantId = await seedTenant();
    const res = await draftChangeOrderScope({ tenantId, jobId: null, description: "add 3 pipe boots" }, fakeAi);
    expect(res.lineItems).toHaveLength(1);
    expect(res.unmatched).toEqual(["nonexistent"]);
    const li = res.lineItems[0]!;
    expect(li.name).toBe("Pipe boots");
    expect(li.unitPriceCents).toBe(2500);
    expect(li.quantity).toBe(3);
    expect(li.amountCents).toBe(7500);
    expect(res.summary).toBe("added boots");
    const runs = await adminDb.select().from(agentRun).where(eq(agentRun.tenantId, tenantId));
    expect(runs.some((r) => r.agent === "finance" && r.taskKey === "change-order.ai-draft" && r.status === "ok")).toBe(true);
  });

  it("logs finance/error and rethrows when the AI call fails", async () => {
    const tenantId = await seedTenant();
    const boomAi = { completeObject: async () => { throw new Error("ai down"); } };
    await expect(draftChangeOrderScope({ tenantId, jobId: null, description: "x" }, boomAi)).rejects.toThrow("ai down");
    const runs = await adminDb.select().from(agentRun).where(eq(agentRun.tenantId, tenantId));
    expect(runs.some((r) => r.agent === "finance" && r.taskKey === "change-order.ai-draft" && r.status === "error")).toBe(true);
  });
});
