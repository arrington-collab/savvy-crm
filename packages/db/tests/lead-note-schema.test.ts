import { describe, it, expect } from "vitest";
import { adminDb, property, leadNote, eq, withTenant } from "../src/index.js";
import { makeTenant, makeUser, makeLeadWithProperty } from "./helpers.js";

describe("Slice 2 schema — property roof columns + lead_note", () => {
  it("round-trips the new property columns", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeLeadWithProperty(tenantId);
    await withTenant(tenantId, (tx) =>
      tx.update(property)
        .set({ roofTypeSecondary: "flat_foam", lastRoofReplacementAt: "2019-04-01", lastRoofReplacementSource: "owner_reported" })
        .where(eq(property.id, propertyId)));
    const [p] = await adminDb.select().from(property).where(eq(property.id, propertyId));
    expect(p!.roofTypeSecondary).toBe("flat_foam");
    expect(p!.lastRoofReplacementSource).toBe("owner_reported");
    expect(String(p!.lastRoofReplacementAt)).toContain("2019-04-01");
  });

  it("inserts a tenant-scoped lead_note", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const { userId: authorUserId } = await makeUser(tenantId);
    const [row] = await adminDb.insert(leadNote).values({ tenantId, leadId, authorUserId, body: "dog in backyard" }).returning();
    expect(row!.body).toBe("dog in backyard");
    const scoped = await withTenant(tenantId, (tx) => tx.select().from(leadNote).where(eq(leadNote.leadId, leadId)));
    expect(scoped).toHaveLength(1);
  });
});
