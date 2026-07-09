import { and, eq, isNull, sql } from "drizzle-orm";
import { job, jobChecklistItem, jobStageEvent, auditLog, document, tenant } from "../schema/index";
import { db } from "../client";
import type { JobStage, Agent } from "@savvy/core";
import { parseProductionConfig, missingRequiredDocs, JOB_STAGE, deriveContiguousStage, missingEvidenceFor } from "@savvy/core";
import { missingProductionPhotos } from "./production-signals";
import { chargebackCommissionsForJob } from "./commission-chargeback";
import { gatherStageEvidence } from "./stage-evidence-db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class IncompletePhotosError extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super("incomplete_photos");
    this.name = "IncompletePhotosError";
    this.missing = missing;
  }
}

export class IncompleteDocumentsError extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super("incomplete_documents");
    this.name = "IncompleteDocumentsError";
    this.missing = missing;
  }
}

export class StageEvidenceError extends Error {
  missing: string | null;
  constructor(missing: string | null) {
    super(missing ? `stage requires evidence: ${missing}` : "stage requires evidence");
    this.name = "StageEvidenceError";
    this.missing = missing;
  }
}
export class BackwardNeedsReasonError extends Error {
  constructor(public readonly fromStage: string, public readonly toStage: string) {
    super(`backward transition ${fromStage}→${toStage} requires a reason`);
    this.name = "BackwardNeedsReasonError";
  }
}

const DUE_DAYS = 3; // Phase 2 default SLA offset for activated tasks

/**
 * Moves a job to `toStage`: updates job.stage + stage_entered_at, writes a
 * job_stage_event, activates that stage's still-pending un-activated tasks
 * (sets due_at), writes an audit_log row. Idempotent: a repeat call with the
 * same toStage activates 0 new tasks.
 */
export async function recordStageChange(
  tx: Tx,
  opts: { tenantId: string; jobId: string; toStage: JobStage; byUserId?: string | null; byAgent?: Agent | null; now?: Date; reason?: string },
): Promise<{ activated: number; fromStage: JobStage | null }> {
  const now = opts.now ?? new Date();
  const [current] = await tx.select({ stage: job.stage }).from(job).where(eq(job.id, opts.jobId));
  const fromStage = (current?.stage ?? null) as JobStage | null;

  // Evidence gate — a job's stage is a consequence of evidence. `lost` is exempt (terminal).
  if (opts.toStage !== "lost" && fromStage) {
    const toIdx = JOB_STAGE.indexOf(opts.toStage);
    const fromIdx = JOB_STAGE.indexOf(fromStage);
    if (toIdx > fromIdx) {
      const ev = await gatherStageEvidence(tx, { tenantId: opts.tenantId, jobId: opts.jobId });
      if (toIdx > JOB_STAGE.indexOf(deriveContiguousStage(ev))) {
        throw new StageEvidenceError(missingEvidenceFor(opts.toStage, ev));
      }
    } else if (toIdx < fromIdx) {
      if (!opts.reason) throw new BackwardNeedsReasonError(fromStage, opts.toStage);
    }
  }

  if (opts.toStage === "complete") {
    const missing = await missingProductionPhotos(tx, opts.tenantId, opts.jobId);
    if (missing.length > 0) throw new IncompletePhotosError(missing);
  }

  // Per-stage document gate: require configured document.kinds before ENTERING toStage.
  {
    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, opts.tenantId));
    const cfg = parseProductionConfig((t?.settings as { production?: unknown } | undefined)?.production);
    const requiredDocs = cfg.requiredDocs[opts.toStage] ?? [];
    if (requiredDocs.length > 0) {
      const rows = await tx.selectDistinct({ kind: document.kind }).from(document)
        .where(eq(document.jobId, opts.jobId));
      const present = rows.map((r) => r.kind).filter((x): x is string => !!x);
      const missing = missingRequiredDocs(requiredDocs, present);
      if (missing.length > 0) throw new IncompleteDocumentsError(missing);
    }
  }

  await tx.update(job).set({ stage: opts.toStage, stageEnteredAt: now }).where(eq(job.id, opts.jobId));

  await tx.insert(jobStageEvent).values({
    tenantId: opts.tenantId, jobId: opts.jobId, fromStage, toStage: opts.toStage,
    enteredAt: now, byUserId: opts.byUserId ?? null, byAgent: opts.byAgent ?? null,
    note: opts.reason ?? null,
  });

  const dueAt = new Date(now.getTime() + DUE_DAYS * 86_400_000);
  const res = await tx.update(jobChecklistItem).set({ dueAt }).where(
    and(
      eq(jobChecklistItem.jobId, opts.jobId),
      eq(jobChecklistItem.status, "pending"),
      isNull(jobChecklistItem.dueAt),
      sql`${jobChecklistItem.payload}->>'stage' = ${opts.toStage}`,
    ),
  ).returning({ id: jobChecklistItem.id });

  // Cell 18: a job cancelled / called back (→ 'lost') auto-charges-back any
  // commission not yet paid out; paid ones are flagged for manual clawback.
  let chargeback: { chargedBack: number; paidNeedingClawback: number } | undefined;
  if (opts.toStage === "lost") {
    chargeback = await chargebackCommissionsForJob(tx, { tenantId: opts.tenantId, jobId: opts.jobId });
  }

  await tx.insert(auditLog).values({
    tenantId: opts.tenantId, agent: opts.byAgent ?? null, userId: opts.byUserId ?? null,
    entityType: "job", entityId: opts.jobId, action: "stage_changed",
    diff: { fromStage, toStage: opts.toStage, activatedTasks: res.length, ...(chargeback ? { chargeback } : {}) },
  });

  return { activated: res.length, fromStage };
}
