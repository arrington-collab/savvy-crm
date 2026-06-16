import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { document } from "../src/schema/ops.js";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

describe("document.label", () => {
  it("persists a photo label", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, customerId } = await makeJobWithCustomer(tenantId);

    const row = await withTenant(tenantId, async (tx) => {
      const [r] = await tx
        .insert(document)
        .values({
          tenantId,
          jobId,
          customerId,
          kind: "photo",
          label: "before",
          r2Key: `${tenantId}/${jobId}/x.jpg`,
          source: "savvy",
        })
        .returning();
      return r;
    });

    expect(row!.label).toBe("before");
  });

  it("allows null label", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);

    const row = await withTenant(tenantId, async (tx) => {
      const [r] = await tx
        .insert(document)
        .values({
          tenantId,
          jobId,
          kind: "contract",
          r2Key: `${tenantId}/${jobId}/contract.pdf`,
        })
        .returning();
      return r;
    });

    expect(row!.label).toBeNull();
  });
});
