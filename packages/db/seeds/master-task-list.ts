import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import type { TaskMode, TaskScope, TaskOwner } from "@savvy/core";
import { taskRegistry } from "../src/schema/task-registry.js";
import type { adminDb } from "../src/admin-client.js";

/**
 * Transforms the extracted Master Task List (master-task-list.raw.json — the
 * faithful, code-reviewed extraction of the 212-task PDF) into task_registry
 * rows. The registry is versioned source, seeded idempotently (upsert on id).
 *
 * Only four fields come from the PDF: name, phase, job type, automation level.
 * Everything else seeds as a documented default and is enriched in later slices:
 *  - default_owner: HUMAN (no agent assigned yet)
 *  - scope: a PHASE-LEVEL HEURISTIC (see PHASE_SCOPE) — refine per-task later
 *  - check_key / verification_tier / sla_hours: null; est_founder_minutes: 0;
 *    depends_on: [] — the Coverage Map fills in as bindings are added (Slice 2+)
 */

type RawTask = { id: number; name: string; phase: number; phaseName: string; jobType: string; automation: string };
type RawFile = { phases: { phase: number; name: string }[]; tasks: RawTask[] };

export type TaskRegistrySeedRow = {
  id: number;
  slug: string;
  name: string;
  phase: number;
  defaultOwner: TaskOwner;
  defaultMode: TaskMode;
  scope: TaskScope;
  appliesTo: { job_types?: string[] };
  checkKey: string | null;
};

/**
 * Binds evidence checks (packages/core/src/verification/checks.ts) to their
 * master task by ID — the handoff's rule: bind by ID, not slug (the mechanical
 * slug scheme differs from the checks' semantic keys). Only 1:1 mappings live
 * here. Cross-cutting guards (comms.no_double_send, comms.body_quality) and
 * enrichment substeps (lead.enrich.*, exceptions.roof_type) stay UNBOUND until
 * Slice 4 designs how the sweep runs task-agnostic "global guard" checks —
 * binding one of those to a single arbitrary task would mis-attribute proof.
 */
export const CHECK_BINDINGS: Record<number, string> = {
  3: "lead.source_taxonomy", // Referral tracking & source attribution — every lead has a recognized source
  6: "canvass.contract_to_job", // Door-to-door canvassing — a signed contract becomes a WON job
  18: "lead.dedupe", // Lead deduplication & merge
  19: "lead.score", // Lead qualification scoring
  24: "drip.appended_guard", // Follow-up sequence (multi-touch)
  28: "lead.won_on_convert", // Lead status pipeline tracking — a job-referenced lead is won/lost, never stuck
  32: "lead.speed_to_contact", // Speed-to-lead monitoring & alerts
  44: "compliance.contract_template", // Contract / authorization signing — SB38 template-version invariant (cell 17b)
  49: "lead.doc_parse", // Measurement report review & import — typed lead doc parsed-or-carded < 1h (slice 6d)
  52: "estimate.lead_stage", // Xactimate estimate creation — lead estimate cites its measurement source (slice 6d)
  76: "claim.endorsement_no_idle", // Mortgage company endorsement tracking — 5-business-day no-idle (cell 16)
  133: "finance.price_guard", // Job cost reconciliation (supplier-invoice price guard)
  139: "finance.invoice_math", // Invoice generation
  141: "finance.stripe_match", // Payment processing — credit card (Stripe collected == payments ledger, cell 8)
  150: "finance.qb_reconcile", // QuickBooks sync — invoices & payments (Savvy AR == QBO AR, cell 8)
  151: "finance.commissions", // Sales commission calculation
  213: "comms.deliverability", // SMS deliverability monitoring (cell 6)
  214: "onboarding.no_lockout", // Onboarding completion monitoring — no-lockout guard (2026-07-06 P0)
};

// PDF "Automation Level" -> registry default_mode.
const MODE_BY_AUTOMATION: Record<string, TaskMode> = {
  "Full Auto": "full_auto",
  "Partial Auto": "assisted",
  Manual: "manual",
};

// Phase -> scope heuristic. Lead phases are per-lead; portfolio/back-office
// phases recur per tenant; the delivery lifecycle is per-job.
const PHASE_SCOPE: Record<number, TaskScope> = {
  1: "per_lead", // Lead Generation
  2: "per_lead", // Lead Management
  10: "per_tenant_recurring", // Reviews & Reputation
  11: "per_tenant_recurring", // Referrals & Retention
  14: "per_tenant_recurring", // Operations & Compliance
  15: "per_tenant_recurring", // Reporting & Analytics
};

// Tenant-recurring tasks the Phase-1 heuristic mis-scopes as per_lead. These are
// tenant-level marketing/ops obligations that must instantiate NOWHERE (Coverage Map only).
// Audit result — Phase 1 recurring marketing + confirmed Phase 10/11/14/15 are already
// per_tenant_recurring via PHASE_SCOPE; these four are the Phase-1 exceptions.
const SCOPE_OVERRIDE: Record<number, TaskScope> = {
  2: "per_tenant_recurring", // Website form submission capture
  4: "per_tenant_recurring", // Google/Facebook ad lead capture
  12: "per_tenant_recurring", // Google Business Profile management
  14: "per_tenant_recurring", // SEO content & blog publishing
};

const kebab = (s: string): string =>
  s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function loadRawTaskList(): RawFile {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, "master-task-list.raw.json"), "utf8")) as RawFile;
}

export function toAppliesTo(jobType: string): { job_types?: string[] } {
  // "All" means no restriction; anything else scopes to that one job type.
  return jobType === "All" ? {} : { job_types: [jobType.toLowerCase()] };
}

/** Build the 212 registry rows from the raw extraction. Slugs are unique + stable. */
export function buildRegistryRows(raw: RawFile = loadRawTaskList()): TaskRegistrySeedRow[] {
  const seen = new Set<string>();
  return raw.tasks.map((t) => {
    const mode = MODE_BY_AUTOMATION[t.automation];
    if (!mode) throw new Error(`task ${t.id}: unknown automation "${t.automation}"`);
    let slug = `${kebab(t.phaseName)}.${kebab(t.name)}`;
    if (seen.has(slug)) slug = `${slug}-${t.id}`; // guarantee uniqueness deterministically
    seen.add(slug);
    return {
      id: t.id,
      slug,
      name: t.name,
      phase: t.phase,
      defaultOwner: "HUMAN",
      defaultMode: mode,
      scope: SCOPE_OVERRIDE[t.id] ?? PHASE_SCOPE[t.phase] ?? "per_job",
      appliesTo: toAppliesTo(t.jobType),
      checkKey: CHECK_BINDINGS[t.id] ?? null,
    };
  });
}

/** @deprecated Use `buildRegistryRows` — kept as an alias for existing call sites. */
export const buildTaskRegistrySeed = buildRegistryRows;

/** Idempotent upsert of the whole registry (source-of-truth, updated by re-seed). */
export async function seedTaskRegistry(db: typeof adminDb): Promise<number> {
  const rows = buildRegistryRows();
  await db
    .insert(taskRegistry)
    .values(rows)
    .onConflictDoUpdate({
      target: taskRegistry.id,
      set: {
        slug: sqlExcluded("slug"),
        name: sqlExcluded("name"),
        phase: sqlExcluded("phase"),
        defaultOwner: sqlExcluded("default_owner"),
        defaultMode: sqlExcluded("default_mode"),
        scope: sqlExcluded("scope"),
        appliesTo: sqlExcluded("applies_to"),
        checkKey: sqlExcluded("check_key"),
        updatedAt: sqlNow(),
      },
    });
  return rows.length;
}

// Reference the INSERT's excluded (would-be-inserted) row for upsert updates.
function sqlExcluded(col: string) {
  return sql.raw(`excluded.${col}`);
}
function sqlNow() {
  return sql`now()`;
}
