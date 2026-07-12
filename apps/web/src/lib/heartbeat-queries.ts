import "server-only";
import { withTenant, agentRun, communication, appointment, leadNote, lead, and, eq, inArray, isNotNull, sql } from "@savvy/db";
import { mergeLastTouch } from "@savvy/core";
import { getTenantId } from "./tenant";

type Row = { id: string | null; ts: string | null };
const clean = (rows: Row[]) => rows.filter((r): r is { id: string; ts: string } => !!r.id && !!r.ts).map((r) => ({ id: r.id, ts: new Date(r.ts) }));

/** Newest agent OR human touch per job. One grouped query per source, merged in JS. */
export async function lastTouchForJobs(jobIds: string[]): Promise<Map<string, Date>> {
  if (jobIds.length === 0) return new Map();
  const tenantId = await getTenantId();
  const [runs, comms, appts] = await Promise.all([
    withTenant(tenantId, (tx) => tx.select({ id: agentRun.jobId, ts: sql<string>`max(${agentRun.startedAt})` }).from(agentRun).where(and(eq(agentRun.tenantId, tenantId), inArray(agentRun.jobId, jobIds))).groupBy(agentRun.jobId)),
    withTenant(tenantId, (tx) => tx.select({ id: communication.jobId, ts: sql<string>`max(${communication.createdAt})` }).from(communication).where(and(eq(communication.tenantId, tenantId), inArray(communication.jobId, jobIds))).groupBy(communication.jobId)),
    withTenant(tenantId, (tx) => tx.select({ id: appointment.jobId, ts: sql<string>`max(${appointment.createdAt})` }).from(appointment).where(and(eq(appointment.tenantId, tenantId), inArray(appointment.jobId, jobIds))).groupBy(appointment.jobId)),
  ]);
  return mergeLastTouch([clean(runs as Row[]), clean(comms as Row[]), clean(appts as Row[])]);
}

/**
 * Newest agent OR human touch per lead. Human touch includes a note, an
 * appointment, AND `lead.firstRepContactAt` — the timestamp the "Log Contact"
 * button writes (its only side effect). Without that source a rep-contacted lead
 * would falsely read cold, violating the honesty invariant.
 */
export async function lastTouchForLeads(leadIds: string[]): Promise<Map<string, Date>> {
  if (leadIds.length === 0) return new Map();
  const tenantId = await getTenantId();
  const [runs, notes, appts, contacts] = await Promise.all([
    withTenant(tenantId, (tx) => tx.select({ id: agentRun.leadId, ts: sql<string>`max(${agentRun.startedAt})` }).from(agentRun).where(and(eq(agentRun.tenantId, tenantId), inArray(agentRun.leadId, leadIds))).groupBy(agentRun.leadId)),
    withTenant(tenantId, (tx) => tx.select({ id: leadNote.leadId, ts: sql<string>`max(${leadNote.createdAt})` }).from(leadNote).where(and(eq(leadNote.tenantId, tenantId), inArray(leadNote.leadId, leadIds))).groupBy(leadNote.leadId)),
    withTenant(tenantId, (tx) => tx.select({ id: appointment.leadId, ts: sql<string>`max(${appointment.createdAt})` }).from(appointment).where(and(eq(appointment.tenantId, tenantId), inArray(appointment.leadId, leadIds))).groupBy(appointment.leadId)),
    withTenant(tenantId, (tx) => tx.select({ id: lead.id, ts: sql<string>`max(${lead.firstRepContactAt})` }).from(lead).where(and(eq(lead.tenantId, tenantId), inArray(lead.id, leadIds), isNotNull(lead.firstRepContactAt))).groupBy(lead.id)),
  ]);
  return mergeLastTouch([clean(runs as Row[]), clean(notes as Row[]), clean(appts as Row[]), clean(contacts as Row[])]);
}
