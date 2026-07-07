import { describe, it, expect } from "vitest";
import { recordLeadDocument, listLeadDocuments } from "../src/lifecycle/lead-documents.js";
import { adminDb, auditLog, eq, and } from "../src/index.js";
import { makeTenant, makeLeadWithProperty, makeUser } from "./helpers.js";

async function record(tenantId: string, leadId: string, kind: string, uploadedByUserId: string | null) {
  return recordLeadDocument({
    tenantId, leadId, uploadedByUserId,
    r2Key: `${tenantId}/lead/${leadId}/${crypto.randomUUID()}.pdf`,
    kind, filename: `${kind}.pdf`, mime: "application/pdf", sizeBytes: 2048,
  });
}

describe("recordLeadDocument / listLeadDocuments", () => {
  it("records a lead-scoped doc, defaults parse_status pending, and writes a timeline audit row", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const { userId } = await makeUser(tenantId);

    const res = await record(tenantId, leadId, "insurance_estimate", userId);
    expect(res).not.toBeNull();

    const docs = await listLeadDocuments({ tenantId, leadId });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.kind).toBe("insurance_estimate");
    expect(docs[0]!.parseStatus).toBe("pending");
    expect(docs[0]!.uploaderName).toBe("Test User");

    const audits = await adminDb.select().from(auditLog).where(
      and(eq(auditLog.entityType, "lead"), eq(auditLog.entityId, leadId)),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("document.uploaded");
  });

  it("returns null when the lead does not exist", async () => {
    const { tenantId } = await makeTenant();
    const res = await record(tenantId, crypto.randomUUID(), "other", null);
    expect(res).toBeNull();
  });

  it("supersedes a prior parseable doc of the same kind (only newest is listed)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);

    await record(tenantId, leadId, "measurement_report", null);
    await record(tenantId, leadId, "measurement_report", null);

    const docs = await listLeadDocuments({ tenantId, leadId });
    expect(docs).toHaveLength(1); // older one archived
  });

  it("does NOT supersede non-parseable kinds (photos stack)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);

    await record(tenantId, leadId, "photo", null);
    await record(tenantId, leadId, "photo", null);

    const docs = await listLeadDocuments({ tenantId, leadId });
    expect(docs).toHaveLength(2);
  });
});
