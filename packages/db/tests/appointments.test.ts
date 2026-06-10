import { describe, it, expect, beforeAll } from "vitest";
import { withTenant } from "../src/tenant.js";
import { appointment } from "../src/schema/comms.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeUser, makeJobWithCustomer } from "./helpers.js";

describe("appointment exclusion constraint", () => {
  let tenantId: string, userId: string, jobId: string;
  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ userId } = await makeUser(tenantId));
    ({ jobId } = await makeJobWithCustomer(tenantId));
  });

  it("rejects an overlapping scheduled appt for the same assignee", async () => {
    await withTenant(tenantId, (tx) => tx.insert(appointment).values({
      tenantId, jobId, type: "inspection", assigneeUserId: userId,
      startsAt: new Date("2026-07-01T15:00:00Z"), endsAt: new Date("2026-07-01T16:00:00Z"),
    }));
    await expect(
      withTenant(tenantId, (tx) => tx.insert(appointment).values({
        tenantId, jobId, type: "inspection", assigneeUserId: userId,
        startsAt: new Date("2026-07-01T15:30:00Z"), endsAt: new Date("2026-07-01T16:30:00Z"),
      })),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("allows the same time for a DIFFERENT assignee", async () => {
    const { userId: other } = await makeUser(tenantId);
    await expect(
      withTenant(tenantId, (tx) => tx.insert(appointment).values({
        tenantId, jobId, type: "inspection", assigneeUserId: other,
        startsAt: new Date("2026-07-01T15:00:00Z"), endsAt: new Date("2026-07-01T16:00:00Z"),
      })),
    ).resolves.toBeDefined();
  });

  it("frees the slot when the blocking appt is canceled", async () => {
    await withTenant(tenantId, (tx) => tx.update(appointment)
      .set({ status: "canceled" })
      .where(eq(appointment.assigneeUserId, userId)));
    await expect(
      withTenant(tenantId, (tx) => tx.insert(appointment).values({
        tenantId, jobId, type: "inspection", assigneeUserId: userId,
        startsAt: new Date("2026-07-01T15:30:00Z"), endsAt: new Date("2026-07-01T16:30:00Z"),
      })),
    ).resolves.toBeDefined();
  });
});
