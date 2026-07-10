import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { taskRegistry } from "../src/schema/index.js";
import {
  buildTaskRegistrySeed,
  buildRegistryRows,
  toAppliesTo,
  seedTaskRegistry,
  CHECK_BINDINGS,
} from "../seeds/master-task-list.js";

// Expected task count per phase (from the code-reviewed extraction of the PDF +
// cell-6 deliverability monitoring (213) and onboarding-lockout guard (214),
// both added to phase 14).
const EXPECTED_PHASE_COUNTS: Record<number, number> = {
  1: 18, 2: 14, 3: 16, 4: 16, 5: 20, 6: 20, 7: 20, 8: 14,
  9: 14, 10: 10, 11: 10, 12: 14, 13: 10, 14: 12, 15: 6,
};

describe("master task list seed (transform)", () => {
  const rows = buildTaskRegistrySeed();

  it("has exactly 214 tasks (212 PDF tasks + task 213 SMS deliverability + task 214 onboarding lockout guard)", () => {
    expect(rows.length).toBe(214);
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    expect(ids[0]).toBe(1);
    expect(ids[213]).toBe(214);
    expect(new Set(ids).size).toBe(214);
  });

  it("phases sum to 214 with the expected per-phase counts", () => {
    const counts: Record<number, number> = {};
    for (const r of rows) counts[r.phase] = (counts[r.phase] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_PHASE_COUNTS);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(214);
    expect(Object.keys(counts).length).toBe(15);
  });

  it("slugs are unique", () => {
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(214);
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

  it("binds evidence check_keys to their 1:1 master task ids (and null elsewhere)", () => {
    const byId = (id: number) => rows.find((r) => r.id === id)!;
    expect(byId(18).checkKey).toBe("lead.dedupe"); // Lead deduplication & merge
    expect(byId(19).checkKey).toBe("lead.score"); // Lead qualification scoring
    expect(byId(24).checkKey).toBe("drip.appended_guard"); // Follow-up sequence (multi-touch)
    expect(byId(28).checkKey).toBe("lead.won_on_convert"); // Lead status pipeline tracking — converted lead is won
    expect(byId(32).checkKey).toBe("lead.speed_to_contact"); // Speed-to-lead monitoring
    expect(byId(133).checkKey).toBe("finance.price_guard"); // Job cost reconciliation (supplier-invoice price guard)
    expect(byId(139).checkKey).toBe("finance.invoice_math"); // Invoice generation
    expect(byId(151).checkKey).toBe("finance.commissions"); // Sales commission calculation
    expect(byId(213).checkKey).toBe("comms.deliverability"); // SMS deliverability monitoring (cell 6)
    expect(byId(214).checkKey).toBe("onboarding.no_lockout"); // Onboarding completion monitoring — no-lockout guard (2026-07-06 P0)
    expect(byId(44).checkKey).toBe("compliance.contract_template"); // Contract / authorization signing (cell 17b SB38)
    expect(byId(76).checkKey).toBe("claim.endorsement_no_idle"); // Mortgage company endorsement tracking (cell 16)
    expect(byId(141).checkKey).toBe("finance.stripe_match"); // Payment processing — credit card (cell 8)
    expect(byId(150).checkKey).toBe("finance.qb_reconcile"); // QuickBooks sync — invoices & payments (cell 8)
    expect(byId(6).checkKey).toBe("canvass.contract_to_job"); // Door-to-door canvassing (contract → job)
    expect(byId(3).checkKey).toBe("lead.source_taxonomy"); // Referral tracking & source attribution
    expect(byId(1).checkKey).toBeNull(); // unbound task keeps null
    // Exactly the bound set carries a check_key; everything else is null.
    const bound = rows.filter((r) => r.checkKey !== null).map((r) => r.id).sort((a, b) => a - b);
    expect(bound).toEqual([3, 6, 18, 19, 24, 28, 32, 44, 49, 52, 76, 133, 139, 141, 150, 151, 213, 214]);
  });

  it("every bound check_key resolves to a real evidence check (no orphan bindings)", () => {
    for (const [taskId, checkKey] of Object.entries(CHECK_BINDINGS)) {
      expect(evidenceChecks[checkKey], `task ${taskId} -> "${checkKey}"`).toBeDefined();
    }
  });
});

describe("master task list scope", () => {
  it("scopes tenant-recurring marketing tasks as per_tenant_recurring", () => {
    const rows = buildRegistryRows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of [2, 4, 12, 14]) {
      expect(byId.get(id)?.scope, `task ${id}`).toBe("per_tenant_recurring");
    }
  });

  it("leaves genuine per_job tasks alone", () => {
    const rows = buildRegistryRows();
    // a core production task (e.g. an install-phase task) stays per_job
    const install = rows.find((r) => r.phase >= 6 && r.phase <= 8);
    expect(install?.scope).toBe("per_job");
  });
});

describe("master task list seed (database, idempotent)", () => {
  // NOTE: the registry is persistent, global seed data (like the price book) —
  // it is intentionally NOT wiped here. Execution-point tests create job_task/
  // lead_task rows referencing real task ids (24/25/56/139/140); wiping the
  // registry would FK-violate against them. The seed is idempotent, so leaving
  // the 212 rows in place across the suite is correct and matches prod.
  afterAll(async () => {
    await adminPool.end();
  });

  it("seeds all 214 rows and is safe to re-run (upsert)", async () => {
    const first = await seedTaskRegistry(adminDb);
    expect(first).toBe(214);
    const again = await seedTaskRegistry(adminDb); // must not throw or duplicate
    expect(again).toBe(214);

    const ids = buildTaskRegistrySeed().map((r) => r.id);
    const stored = await adminDb.select().from(taskRegistry).where(inArray(taskRegistry.id, ids));
    expect(stored.length).toBe(214);
    const t1 = stored.find((r) => r.id === 1)!;
    expect(t1.slug).toBeTruthy();
    expect(t1.defaultMode).toBe("full_auto");
  });

  it("persists check_key bindings and refreshes them on re-seed", async () => {
    await seedTaskRegistry(adminDb);
    await seedTaskRegistry(adminDb); // re-seed must keep bindings in place, not null them
    const bound = await adminDb.select().from(taskRegistry).where(inArray(taskRegistry.id, [18, 151, 1]));
    expect(bound.find((r) => r.id === 18)!.checkKey).toBe("lead.dedupe");
    expect(bound.find((r) => r.id === 151)!.checkKey).toBe("finance.commissions");
    expect(bound.find((r) => r.id === 1)!.checkKey).toBeNull();
  });
});
