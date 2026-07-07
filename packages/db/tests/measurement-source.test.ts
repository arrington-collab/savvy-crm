import { describe, it, expect } from "vitest";
import { adminDb, measurement, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("measurement.source column", () => {
  it("stores an explicit source value and round-trips it", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeLeadWithProperty(tenantId);
    const [row] = await adminDb
      .insert(measurement)
      .values({ tenantId, propertyId, provider: "roofr", source: "uploaded_report", areas: {} })
      .returning();
    const [read] = await adminDb.select().from(measurement).where(eq(measurement.id, row!.id));
    expect(read!.source).toBe("uploaded_report");
  });
});
