import { and, eq, or, inArray, sql } from "drizzle-orm";
import { job } from "../schema/jobs";
import { appointment } from "../schema/comms";
import { estimate, invoice } from "../schema/finance";
import { document } from "../schema/ops";
import { materialOrder } from "../schema/procurement";
import { db } from "../client";
import type { StageEvidence } from "@savvy/core";
import { missingProductionPhotos } from "./production-signals";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Read the evidence booleans for one job from the existing tables (job- and lead-scoped). */
export async function gatherStageEvidence(tx: Tx, input: { tenantId: string; jobId: string }): Promise<StageEvidence> {
  const [j] = await tx.select({ leadId: job.leadId }).from(job).where(eq(job.id, input.jobId));
  const leadId = j?.leadId ?? null;
  // job-or-lead scoping for pre-job (lead-scoped) evidence
  const jobOrLead = (jobCol: unknown, leadCol: unknown) =>
    leadId ? or(eq(jobCol as never, input.jobId), eq(leadCol as never, leadId)) : eq(jobCol as never, input.jobId);
  const exists = async (rows: Promise<{ x: number }[]>) => (await rows).length > 0;

  const inspectionAppt = exists(
    tx.select({ x: sql<number>`1` }).from(appointment)
      .where(and(jobOrLead(appointment.jobId, appointment.leadId), eq(appointment.type, "inspection"), eq(appointment.status, "done"))).limit(1),
  );
  const anyPhoto = exists(
    tx.select({ x: sql<number>`1` }).from(document)
      .where(and(jobOrLead(document.jobId, document.leadId), eq(document.kind, "photo"))).limit(1),
  );
  const anyEstimate = exists(
    tx.select({ x: sql<number>`1` }).from(estimate).where(jobOrLead(estimate.jobId, estimate.leadId)).limit(1),
  );
  const acceptedEstimate = exists(
    tx.select({ x: sql<number>`1` }).from(estimate).where(and(jobOrLead(estimate.jobId, estimate.leadId), eq(estimate.status, "accepted"))).limit(1),
  );
  const contractDoc = exists(
    tx.select({ x: sql<number>`1` }).from(document).where(and(jobOrLead(document.jobId, document.leadId), eq(document.kind, "contract"))).limit(1),
  );
  const crewScheduled = exists(
    tx.select({ x: sql<number>`1` }).from(appointment).where(and(eq(appointment.jobId, input.jobId), eq(appointment.type, "crew"), eq(appointment.status, "scheduled"))).limit(1),
  );
  const materialsOrdered = exists(
    tx.select({ x: sql<number>`1` }).from(materialOrder).where(and(eq(materialOrder.jobId, input.jobId), inArray(materialOrder.status, ["ordered", "delivered"]))).limit(1),
  );
  const anyInvoice = exists(
    tx.select({ x: sql<number>`1` }).from(invoice).where(eq(invoice.jobId, input.jobId)).limit(1),
  );
  const paidInvoice = exists(
    tx.select({ x: sql<number>`1` }).from(invoice).where(and(eq(invoice.jobId, input.jobId), eq(invoice.status, "paid"))).limit(1),
  );

  const [insp, photo, est, acc, contract, crew, mats, inv, paid, missPhotos] = await Promise.all([
    inspectionAppt, anyPhoto, anyEstimate, acceptedEstimate, contractDoc, crewScheduled, materialsOrdered, anyInvoice, paidInvoice,
    missingProductionPhotos(tx, input.tenantId, input.jobId),
  ]);

  return {
    inspection: insp || photo,
    estimate: est,
    approval: acc || contract,
    production: crew || mats,
    closeoutPhotos: missPhotos.length === 0,
    invoice: inv,
    invoicePaid: paid,
  };
}
