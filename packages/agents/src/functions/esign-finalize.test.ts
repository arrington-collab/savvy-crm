import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  adminDb, adminPool, pool, eq,
  tenant, customer, property, job, document, esignRequest,
} from "@savvy/db";
import { makeFakeDocuseal, makeFakeStorage } from "@savvy/integrations";
import { finalizeEsign } from "./esign-finalize";

let tId: string, custId: string, propId: string, jobId: string, reqId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "EF", publicKey: "ef", clerkOrgId: "org_ef" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Pat", email: "pat@x.com" }).returning();
  custId = c!.id;
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: custId, address: "1 Main St" }).returning();
  propId = p!.id;
  const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: custId, propertyId: propId }).returning();
  jobId = j!.id;
  const [r] = await adminDb.insert(esignRequest).values({
    tenantId: tId, jobId, customerId: custId, docType: "cert",
    templateId: "tpl", docusealSubmissionId: "sub_ef_1", status: "completed",
  }).returning();
  reqId = r!.id;
});

afterAll(async () => {
  await adminDb.delete(esignRequest).where(eq(esignRequest.tenantId, tId));
  await adminDb.delete(document).where(eq(document.tenantId, tId));
  await adminDb.delete(job).where(eq(job.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("finalizeEsign", () => {
  it("downloads the PDF, stores a document, and links it to the request", async () => {
    const docuseal = makeFakeDocuseal();
    const storage = makeFakeStorage();
    const r = await finalizeEsign({ tenantId: tId, requestId: reqId }, { docuseal, storage });
    expect(r.stored).toBe(true);

    const docs = await adminDb.select().from(document).where(eq(document.jobId, jobId));
    expect(docs.length).toBe(1);
    expect(docs[0]!.source).toBe("docuseal");
    expect(docs[0]!.kind).toBe("cert");
    expect(docs[0]!.r2Key).toContain(`${tId}/${jobId}/esign-${reqId}`);
    expect(storage.calls.some((c) => c.op === "put")).toBe(true);

    const [er] = await adminDb.select().from(esignRequest).where(eq(esignRequest.id, reqId));
    expect(er!.documentId).toBe(docs[0]!.id);
  });

  it("is idempotent — a second run stores nothing new", async () => {
    const docuseal = makeFakeDocuseal();
    const storage = makeFakeStorage();
    const r = await finalizeEsign({ tenantId: tId, requestId: reqId }, { docuseal, storage });
    expect(r.stored).toBe(false);
    expect(r.reason).toBe("already_finalized");

    const docs = await adminDb.select().from(document).where(eq(document.jobId, jobId));
    expect(docs.length).toBe(1); // still just the one from the first test
  });
});
