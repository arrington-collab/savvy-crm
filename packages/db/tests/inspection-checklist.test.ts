import { describe, it, expect } from "vitest";
import { ensureInspectionChecklists } from "../src/lifecycle/inspection-checklist.js";
import { adminDb, inspectionChecklist, eq } from "../src/index.js";
import { makeTenant } from "./helpers.js";

/**
 * Library-versioned checklists, seeded v1 from BloomCam's built-in templates.
 * Revisions are config (new version rows), not code — the seed never overwrites.
 */
describe("ensureInspectionChecklists", () => {
  it("seeds v1 checklists covering the core zone kinds, with photo-required items", async () => {
    const { tenantId } = await makeTenant();
    const res = await ensureInspectionChecklists(tenantId);
    expect(res.seeded).toBeGreaterThan(0);

    const rows = await adminDb.select().from(inspectionChecklist).where(eq(inspectionChecklist.tenantId, tenantId));
    const kinds = new Set(rows.map((r) => r.zoneKind));
    for (const kind of ["ground", "facet", "gutters", "penetrations", "attic"]) {
      expect(kinds.has(kind)).toBe(true);
    }
    expect(rows.every((r) => r.version === 1 && r.active)).toBe(true);

    // Items carry the capture contract: key, prompt, input kind, finding template flag.
    const facet = rows.find((r) => r.zoneKind === "facet")!;
    const items = facet.items as { key: string; prompt: string; input: string; friend_rule_eligible?: boolean }[];
    expect(items.length).toBeGreaterThan(2);
    expect(items.every((i) => i.key && i.prompt && i.input)).toBe(true);
    expect(items.some((i) => i.input === "photo_required")).toBe(true);
  });

  it("is idempotent — a second run seeds nothing and never bumps versions", async () => {
    const { tenantId } = await makeTenant();
    await ensureInspectionChecklists(tenantId);
    const again = await ensureInspectionChecklists(tenantId);
    expect(again).toEqual({ seeded: 0 });

    const rows = await adminDb.select().from(inspectionChecklist).where(eq(inspectionChecklist.tenantId, tenantId));
    expect(rows.every((r) => r.version === 1)).toBe(true);
  });
});
