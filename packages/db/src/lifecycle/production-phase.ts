// Production Pulse slice 1: the live phase engine. Crews advance phases by
// CAPTURING — a photo landing for a phase sets it in_progress; the template's
// evidence definition (count + required shots, Library-versioned) completes it.
// Unknown phase context is HELD for triage, never silently dropped.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { job, document, productionPhase, productionPhaseTemplate, productionMedia, municipalInspection } from "../schema/index";
import { DEFAULT_PHASE_TEMPLATES, evaluatePhaseEvidence, phaseProgress, type PhaseTemplateItem, type PhaseProgress } from "@savvy/core";

/** Seeds the v1 phase-template library. Idempotent: existing rows (any version) win. */
export async function ensureProductionPhaseTemplates(tenantId: string): Promise<{ seeded: number }> {
  return withTenant(tenantId, async (tx) => {
    const existing = await tx.select({ id: productionPhaseTemplate.id }).from(productionPhaseTemplate).limit(1);
    if (existing.length > 0) return { seeded: 0 };
    const inserted = await tx.insert(productionPhaseTemplate)
      .values((Object.keys(DEFAULT_PHASE_TEMPLATES) as (keyof typeof DEFAULT_PHASE_TEMPLATES)[])
        .map((jobType) => ({ tenantId, jobType, version: 1, items: DEFAULT_PHASE_TEMPLATES[jobType] as unknown[] })))
      .onConflictDoNothing()
      .returning({ id: productionPhaseTemplate.id });
    return { seeded: inserted.length };
  });
}

async function activeTemplateFor(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  jobType: string,
): Promise<{ ref: string; items: PhaseTemplateItem[] } | null> {
  const [tpl] = await tx.select().from(productionPhaseTemplate)
    .where(and(eq(productionPhaseTemplate.jobType, jobType), eq(productionPhaseTemplate.active, true)))
    .orderBy(sql`${productionPhaseTemplate.version} desc`)
    .limit(1);
  if (!tpl) return null;
  return { ref: `${tpl.jobType}-v${tpl.version}`, items: tpl.items as PhaseTemplateItem[] };
}

export type InstantiateResult =
  | { created: number; skipped?: "already_instantiated" }
  | { error: "job_not_found" | "no_template" };

/** Instantiate the job type's phases at production start. Idempotent per job. */
export async function instantiateProductionPhases(input: {
  tenantId: string;
  jobId: string;
}): Promise<InstantiateResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id, type: job.type }).from(job).where(eq(job.id, input.jobId));
    if (!j) return { error: "job_not_found" as const };

    const [existing] = await tx.select({ id: productionPhase.id }).from(productionPhase)
      .where(eq(productionPhase.jobId, input.jobId)).limit(1);
    if (existing) return { created: 0, skipped: "already_instantiated" as const };

    const tpl = await activeTemplateFor(tx, j.type ?? "retail");
    if (!tpl) return { error: "no_template" as const };

    const inserted = await tx.insert(productionPhase)
      .values(tpl.items.map((item) => ({
        tenantId: input.tenantId,
        jobId: input.jobId,
        phaseKey: item.key,
        label: item.label,
        sortOrder: item.sortOrder,
        customerVisible: item.customerVisible,
        expectedDurationHours: item.expectedDurationHours,
        templateVersionRef: tpl.ref,
      })))
      .onConflictDoNothing()
      .returning({ id: productionPhase.id });
    return { created: inserted.length };
  });
}

export type IngestProductionMediaResult =
  | { phaseId: string; phaseStatus: string; justCompleted: boolean }
  | { triaged: true; documentId: string }
  | { gated: true; requiredInspectionKey: string; documentId: string }
  | { error: "job_not_found" };

/**
 * One phase-tagged photo lands. Replay-safe via the (job, document) unique
 * link; the phase's template evidence definition decides completion. Unknown
 * phaseKey ⇒ a triage-held media row (null phase id) — the office card picks
 * it up; the photo is never dropped.
 */
export async function ingestProductionMedia(input: {
  tenantId: string;
  jobId: string;
  phaseKey: string;
  documentId: string;
  shot?: string | null;
  crewId?: string | null;
  crewMemberName?: string | null;
  capturedAt?: Date | null;
}): Promise<IngestProductionMediaResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id }).from(job).where(eq(job.id, input.jobId));
    if (!j) return { error: "job_not_found" as const };

    const [phase] = await tx.select().from(productionPhase)
      .where(and(eq(productionPhase.jobId, input.jobId), eq(productionPhase.phaseKey, input.phaseKey)));

    const mediaValues = {
      tenantId: input.tenantId,
      jobId: input.jobId,
      productionPhaseId: phase?.id ?? null,
      phaseKeyRaw: input.phaseKey,
      documentId: input.documentId,
      shot: input.shot ?? null,
      crewId: input.crewId ?? null,
      crewMemberName: input.crewMemberName ?? null,
      capturedAt: input.capturedAt ?? null,
    };
    const inserted = await tx.insert(productionMedia).values(mediaValues)
      .onConflictDoNothing().returning({ id: productionMedia.id });
    const isNew = inserted.length > 0;

    if (!phase) return { triaged: true as const, documentId: input.documentId };

    // Municipal gate (slice 3): a jurisdiction-gated phase cannot START until
    // its PASSED inspection record exists — the photo is kept (media row above)
    // but the phase never leaves pending, and the office gets the gate card.
    if (phase.status === "pending" && phase.requiredInspectionKey) {
      const [passed] = await tx.select({ id: municipalInspection.id }).from(municipalInspection)
        .where(and(
          eq(municipalInspection.jobId, input.jobId),
          eq(municipalInspection.inspectionKey, phase.requiredInspectionKey),
          eq(municipalInspection.status, "passed"),
        ));
      if (!passed) return { gated: true as const, requiredInspectionKey: phase.requiredInspectionKey, documentId: input.documentId };
    }

    // First evidence flips pending → in_progress (startedAt stamps once).
    if (phase.status === "pending") {
      await tx.update(productionPhase)
        .set({ status: "in_progress", startedAt: sql`coalesce(${productionPhase.startedAt}, now())` })
        .where(and(eq(productionPhase.id, phase.id), eq(productionPhase.status, "pending")));
      phase.status = "in_progress";
    }

    // Evidence evaluation against the phase's OWN template version (audit-stable).
    let justCompleted = false;
    if (isNew && (phase.status === "in_progress" || phase.status === "pending")) {
      const media = await tx.select({ documentId: productionMedia.documentId, shot: productionMedia.shot })
        .from(productionMedia).where(eq(productionMedia.productionPhaseId, phase.id));
      const tplItems = await templateItemsForRef(tx, phase.templateVersionRef);
      const item = tplItems?.find((i) => i.key === phase.phaseKey);
      if (item && evaluatePhaseEvidence(item, media).complete) {
        await tx.update(productionPhase).set({
          status: "done",
          completedAt: new Date(),
          evidencePhotoIds: media.map((m) => m.documentId),
        }).where(eq(productionPhase.id, phase.id));
        phase.status = "done";
        justCompleted = true;
      }
    }

    return { phaseId: phase.id, phaseStatus: phase.status, justCompleted };
  });
}

async function templateItemsForRef(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  ref: string | null,
): Promise<PhaseTemplateItem[] | null> {
  if (!ref) return null;
  const [jobType, v] = ref.split("-v");
  const version = Number(v);
  if (!jobType || !Number.isFinite(version)) return null;
  const [tpl] = await tx.select({ items: productionPhaseTemplate.items }).from(productionPhaseTemplate)
    .where(and(eq(productionPhaseTemplate.jobType, jobType), eq(productionPhaseTemplate.version, version)));
  return (tpl?.items as PhaseTemplateItem[]) ?? null;
}

export type ReopenResult =
  | { reopened: true; phaseId: string; phaseKey: string; jobId: string; documentId: string }
  | { reopened: false };

/** QC flags a photo that was COMPLETION evidence ⇒ the phase reopens (punch).
 *  Photos outside any done phase's evidence set reopen nothing. */
export async function reopenPhaseForQcFailure(input: {
  tenantId: string;
  documentId: string;
}): Promise<ReopenResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [d] = await tx.select({ qcStatus: document.qcStatus }).from(document)
      .where(eq(document.id, input.documentId));
    if (d?.qcStatus !== "flagged") return { reopened: false as const };

    const [phase] = await tx.select().from(productionPhase)
      .where(and(
        eq(productionPhase.status, "done"),
        sql`${productionPhase.evidencePhotoIds} @> ${JSON.stringify([input.documentId])}::jsonb`,
      ));
    if (!phase) return { reopened: false as const };

    await tx.update(productionPhase)
      .set({ status: "in_progress", completedAt: null })
      .where(eq(productionPhase.id, phase.id));
    return { reopened: true as const, phaseId: phase.id, phaseKey: phase.phaseKey, jobId: phase.jobId, documentId: input.documentId };
  });
}

/** Triage tray: photos that arrived with unknown phase context. Never dropped. */
export async function listTriageMedia(tenantId: string): Promise<{ id: string; jobId: string; documentId: string; phaseKeyRaw: string | null; createdAt: Date }[]> {
  return withTenant(tenantId, (tx) => tx.select({
    id: productionMedia.id, jobId: productionMedia.jobId, documentId: productionMedia.documentId,
    phaseKeyRaw: productionMedia.phaseKeyRaw, createdAt: productionMedia.createdAt,
  }).from(productionMedia).where(isNull(productionMedia.productionPhaseId)));
}

/** The job-card line ("Install — 60%, on pace"). Null if no phases instantiated. */
export async function getPhaseProgressForJob(input: {
  tenantId: string;
  jobId: string;
}): Promise<(PhaseProgress & { phases: { key: string; label: string; status: string; customerVisible: boolean }[] }) | null> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx.select().from(productionPhase)
      .where(eq(productionPhase.jobId, input.jobId))
      .orderBy(asc(productionPhase.sortOrder));
    if (rows.length === 0) return null;
    const progress = phaseProgress(
      rows.map((r) => ({ key: r.phaseKey, status: r.status, startedAt: r.startedAt, expectedDurationHours: r.expectedDurationHours })),
      new Date(),
    );
    return { ...progress, phases: rows.map((r) => ({ key: r.phaseKey, label: r.label, status: r.status, customerVisible: r.customerVisible })) };
  });
}
