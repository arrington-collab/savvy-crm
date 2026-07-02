import { describe, it, expect } from "vitest";
import { computeTenantUsage } from "../src/lifecycle/usage.js";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client.js";
import { agentRun, communication, document, job } from "../src/schema/index.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

describe("computeTenantUsage", () => {
  it("aggregates jobs, ai spend, voice minutes, active storage in the period", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithProperty(tenantId); // helper sets openedAt = now
    const start = new Date("2026-06-01T00:00:00Z");
    const end = new Date("2026-07-01T00:00:00Z");
    const mid = new Date("2026-06-15T00:00:00Z");
    // Pin openedAt inside the fixed period so the test is clock-independent
    // (otherwise it fails once the real date passes `end`).
    await adminDb.update(job).set({ openedAt: mid }).where(eq(job.id, jobId));

    await adminDb.insert(agentRun).values({ tenantId, agent: "finance", status: "ok", costCents: 250, startedAt: mid });
    await adminDb.insert(communication).values({ tenantId, channel: "call", direction: "inbound", durationSeconds: 180, createdAt: mid });
    await adminDb.insert(communication).values({ tenantId, channel: "sms", direction: "inbound", durationSeconds: 999, createdAt: mid }); // excluded (not call)
    await adminDb.insert(document).values({ tenantId, kind: "photo", r2Key: `a-${crypto.randomUUID()}`, sizeBytes: 1000, createdAt: mid });
    await adminDb.insert(document).values({ tenantId, kind: "photo", r2Key: `b-${crypto.randomUUID()}`, sizeBytes: 5000, archivedAt: mid, createdAt: mid }); // excluded (archived)

    const u = await computeTenantUsage(tenantId, start, end);
    expect(u.aiSpendCents).toBe(250);
    expect(u.aiVoiceMinutes).toBe(3); // floor(180/60)
    expect(u.storageBytes).toBe(1000); // archived excluded
    expect(u.jobsProcessed).toBeGreaterThanOrEqual(1);
  });
});
