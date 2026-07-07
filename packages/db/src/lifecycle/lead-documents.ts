import { withTenant } from "../tenant";
import { document } from "../schema/ops";
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
