import { withTenant } from "../tenant";
import { document, measurement } from "../schema/ops";
import { lead } from "../schema/crm";
import { auditLog } from "../schema/agents";
import { user } from "../schema/tenancy";
import { and, eq, isNull, desc } from "drizzle-orm";
import { PARSEABLE_KINDS } from "@savvy/core";

export interface LeadDocumentRow {
  id: string;
  kind: string;
  filename: string | null;
  mime: string | null;
  sizeBytes: number | null;
  parseStatus: string;
  parseConfidence: number | null;
  uploaderName: string | null;
  createdAt: Date;
}

/**
 * Record a lead-scoped document. Derives property/customer from the lead, writes a
 * `document.uploaded` audit_log timeline row, and supersedes a prior active doc of the
 * same PARSEABLE kind (single-slot). Returns null when the lead doesn't exist.
 */
export async function recordLeadDocument(input: {
  tenantId: string;
  leadId: string;
  r2Key: string;
  kind: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  uploadedByUserId: string | null;
}): Promise<{ id: string } | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [l] = await tx
      .select({ customerId: lead.customerId, propertyId: lead.propertyId })
      .from(lead)
      .where(eq(lead.id, input.leadId));
    if (!l) return null;

    // Supersede: a newer single-slot (parseable) doc archives the prior active one.
    if ((PARSEABLE_KINDS as readonly string[]).includes(input.kind)) {
      await tx
        .update(document)
        .set({ archivedAt: new Date() })
        .where(and(
          eq(document.leadId, input.leadId),
          eq(document.kind, input.kind),
          isNull(document.archivedAt),
        ));
    }

    const [row] = await tx
      .insert(document)
      .values({
        tenantId: input.tenantId,
        leadId: input.leadId,
        propertyId: l.propertyId ?? null,
        customerId: l.customerId ?? null,
        kind: input.kind,
        r2Key: input.r2Key,
        filename: input.filename,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        uploadedByUserId: input.uploadedByUserId,
        source: "savvy",
        parseStatus: "pending",
      })
      .returning({ id: document.id });

    await tx.insert(auditLog).values({
      tenantId: input.tenantId,
      userId: input.uploadedByUserId,
      entityType: "lead",
      entityId: input.leadId,
      action: "document.uploaded",
      diff: { kind: input.kind, filename: input.filename },
    });

    return { id: row!.id };
  });
}

/** Active (non-archived) lead documents, newest-first, with uploader name. */
export async function listLeadDocuments(input: {
  tenantId: string;
  leadId: string;
}): Promise<LeadDocumentRow[]> {
  return withTenant(input.tenantId, async (tx) => {
    return tx
      .select({
        id: document.id,
        kind: document.kind,
        filename: document.filename,
        mime: document.mime,
        sizeBytes: document.sizeBytes,
        parseStatus: document.parseStatus,
        parseConfidence: document.parseConfidence,
        uploaderName: user.name,
        createdAt: document.createdAt,
      })
      .from(document)
      .leftJoin(user, eq(document.uploadedByUserId, user.id))
      .where(and(eq(document.leadId, input.leadId), isNull(document.archivedAt)))
      .orderBy(desc(document.createdAt));
  });
}

/** Load the fields the parse pipeline needs for one lead document. */
export async function getLeadDocumentForParse(
  tenantId: string,
  documentId: string,
): Promise<{ r2Key: string | null; kind: string; leadId: string | null; propertyId: string | null } | null> {
  return withTenant(tenantId, async (tx) => {
    const [d] = await tx
      .select({ r2Key: document.r2Key, kind: document.kind, leadId: document.leadId, propertyId: document.propertyId })
      .from(document)
      .where(eq(document.id, documentId));
    return d ?? null;
  });
}

/**
 * Insert-or-update the property's uploaded-report measurement (provider roofr, source
 * uploaded_report). A re-parse UPDATES the newest existing uploaded_report row rather than
 * inserting a duplicate, so the measurement id (and its downstream estimate auto-draft) is
 * stable across re-parses. First parse inserts. Returns the measurement id.
 */
export async function upsertUploadedMeasurement(input: {
  tenantId: string;
  propertyId: string;
  areas: Record<string, unknown>;
  pitch: string | null;
}): Promise<string> {
  return withTenant(input.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: measurement.id })
      .from(measurement)
      .where(and(eq(measurement.propertyId, input.propertyId), eq(measurement.source, "uploaded_report")))
      .orderBy(desc(measurement.createdAt))
      .limit(1);
    if (existing) {
      await tx
        .update(measurement)
        .set({ areas: input.areas, pitch: input.pitch, provider: "roofr" })
        .where(eq(measurement.id, existing.id));
      return existing.id;
    }
    const [m] = await tx
      .insert(measurement)
      .values({
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        provider: "roofr",
        source: "uploaded_report",
        areas: input.areas,
        pitch: input.pitch,
      })
      .returning({ id: measurement.id });
    return m!.id;
  });
}

/** Set a document's parse lifecycle status (+ optional 0-1 confidence). */
export async function setDocumentParseStatus(input: {
  tenantId: string;
  documentId: string;
  status: string;
  confidence?: number | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx
      .update(document)
      .set({ parseStatus: input.status, parseConfidence: input.confidence ?? null })
      .where(eq(document.id, input.documentId)),
  );
}
