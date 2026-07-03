import { and, eq } from "drizzle-orm";
import { job, tenant, document, appointment } from "../schema/index";
import { db } from "../client";
import { parseProductionConfig, missingRequiredPhotos, type JobType } from "@savvy/core";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Required production-day photo labels that are NOT yet present on the job.
 * Reads the tenant's `production.requiredPhotos[jobType]` checklist and compares
 * it against the distinct labels on the job's `kind='photo'` documents. An empty
 * result means the photo checklist is satisfied. Single source of truth for both
 * the completion gate (record-stage-change) and the closeout trigger.
 */
export async function missingProductionPhotos(tx: Tx, tenantId: string, jobId: string): Promise<string[]> {
  const [j] = await tx.select({ type: job.type }).from(job).where(eq(job.id, jobId));
  const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const cfg = parseProductionConfig((t?.settings as { production?: unknown } | undefined)?.production);
  const required = cfg.requiredPhotos[(j?.type ?? "retail") as JobType] ?? [];
  if (required.length === 0) return [];
  const rows = await tx
    .selectDistinct({ label: document.label })
    .from(document)
    .where(and(eq(document.jobId, jobId), eq(document.kind, "photo")));
  const present = rows.map((r) => r.label).filter((x): x is string => !!x);
  return missingRequiredPhotos(required, present);
}

/** True when the job has at least one scheduled crew (install) appointment — i.e. a crew is assigned. */
export async function hasScheduledCrewInstall(tx: Tx, jobId: string): Promise<boolean> {
  const [appt] = await tx
    .select({ id: appointment.id })
    .from(appointment)
    .where(and(eq(appointment.jobId, jobId), eq(appointment.type, "crew"), eq(appointment.status, "scheduled")))
    .limit(1);
  return !!appt;
}
