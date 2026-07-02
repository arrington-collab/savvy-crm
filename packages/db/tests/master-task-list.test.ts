import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { taskRegistry } from "../src/schema/index.js";
import { buildTaskRegistrySeed, toAppliesTo, seedTaskRegistry } from "../seeds/master-task-list.js";

// Expected task count per phase (from the code-reviewed extraction of the PDF).
const EXPECTED_PHASE_COUNTS: Record<number, number> = {
  1: 18, 2: 14, 3: 16, 4: 16, 5: 20, 6: 20, 7: 20, 8: 14,
  9: 14, 10: 10, 11: 10, 12: 14, 13: 10, 14: 10, 15: 6,
};

describe("master task list seed (transform)", () => {
  const rows = buildTaskRegistrySeed();

  it("has exactly 212 tasks with contiguous ids 1..212", () => {
    expect(rows.length).toBe(212);
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    expect(ids[0]).toBe(1);
    expect(ids[211]).toBe(212);
    expect(new Set(ids).size).toBe(212);
  });

  it("phases sum to 212 with the expected per-phase counts", () => {
    const counts: Record<number, number> = {};
    for (const r of rows) counts[r.phase] = (counts[r.phase] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_PHASE_COUNTS);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(212);
    expect(Object.keys(counts).length).toBe(15);
  });

  it("slugs are unique", () => {
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(212);
    expect(slugs.every((s) => /^[a-z0-9.-]+$/.test(s))).toBe(true);
  });

  it("maps the PDF automation level to default_mode", () => {
    expect(rows.find((r) => r.id === 1)!.defaultMode).toBe("full_auto"); // Full Auto
    expect(rows.find((r) => r.id === 6)!.defaultMode).toBe("assisted"); // Partial Auto
    expect(rows.find((r) => r.id === 37)!.defaultMode).toBe("manual"); // Manual
  });

  it("derives applies_to from job type (All = unrestricted; repair allowed)", () => {
    expect(toAppliesTo("All")).toEqual({});
    expect(toAppliesTo("Insurance")).toEqual({ job_types: ["insurance"] });
    expect(toAppliesTo("Repair")).toEqual({ job_types: ["repair"] });
    expect(rows.find((r) => r.id === 5)!.appliesTo).toEqual({ job_types: ["insurance"] }); // Storm monitoring
    expect(rows.find((r) => r.id === 180)!.appliesTo).toEqual({ job_types: ["repair"] }); // Emergency job prioritization
  });

  it("applies the phase scope heuristic and a HUMAN default owner", () => {
    expect(rows.find((r) => r.phase === 1)!.scope).toBe("per_lead");
    expect(rows.find((r) => r.phase === 7)!.scope).toBe("per_job");
    expect(rows.find((r) => r.phase === 15)!.scope).toBe("per_tenant_recurring");
    expect(rows.every((r) => r.defaultOwner === "HUMAN")).toBe(true);
  });
});

describe("master task list seed (database, idempotent)", () => {
  afterAll(async () => {
    await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, buildTaskRegistrySeed().map((r) => r.id)));
    await adminPool.end();
  });

  it("seeds all 212 rows and is safe to re-run (upsert)", async () => {
    const first = await seedTaskRegistry(adminDb);
    expect(first).toBe(212);
    const again = await seedTaskRegistry(adminDb); // must not throw or duplicate
    expect(again).toBe(212);

    const ids = buildTaskRegistrySeed().map((r) => r.id);
    const stored = await adminDb.select().from(taskRegistry).where(inArray(taskRegistry.id, ids));
    expect(stored.length).toBe(212);
    const t1 = stored.find((r) => r.id === 1)!;
    expect(t1.slug).toBeTruthy();
    expect(t1.defaultMode).toBe("full_auto");
  });
});
