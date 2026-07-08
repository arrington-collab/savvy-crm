import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDocumentParseSummaries } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, document, claim, measurement } from "../src/schema/index.js";

let tenantId: string, leadId: string, propertyId: string;
let insDocId: string, measDocId: string, lowDocId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "PS", publicKey: `ps-${Date.now()}`, clerkOrgId: `org_ps_${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  propertyId = p!.id;
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId, source: "test", status: "new" }).returning();
  leadId = l!.id;

  const [insDoc] = await adminDb.insert(document).values({ tenantId, leadId, propertyId, kind: "insurance_estimate", parseStatus: "parsed", parseConfidence: 0.9, r2Key: "k1" }).returning();
  insDocId = insDoc!.id;
  await adminDb.insert(claim).values({ tenantId, leadId, propertyId, carrierName: "Acme", claimNumber: "CLM-1", acvCents: 100000, rcvCents: 150000, deductibleCents: 100000, lineItems: [{}, {}, {}], parseConfidence: 0.9 });

  const [measDoc] = await adminDb.insert(document).values({ tenantId, leadId, propertyId, kind: "measurement_report", parseStatus: "parsed", parseConfidence: 0.85, r2Key: "k2" }).returning();
  measDocId = measDoc!.id;
  await adminDb.insert(measurement).values({ tenantId, propertyId, provider: "roofr", source: "uploaded_report", areas: { squares: 24, predominantPitch: "8/12", ridgeLf: 40, facetCount: 6 }, pitch: "8/12" });

  const [lowDoc] = await adminDb.insert(document).values({ tenantId, leadId, propertyId, kind: "insurance_estimate", parseStatus: "unparsed_low_confidence", parseConfidence: 0.4, r2Key: "k3" }).returning();
  lowDocId = lowDoc!.id;
});

afterAll(async () => {
  await adminDb.delete(document).where(eq(document.tenantId, tenantId));
  await adminDb.delete(claim).where(eq(claim.tenantId, tenantId));
  await adminDb.delete(measurement).where(eq(measurement.tenantId, tenantId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("getDocumentParseSummaries", () => {
  it("insurance parsed → claim summary with lineItemCount", async () => {
    const map = await getDocumentParseSummaries({ tenantId, documentIds: [insDocId] });
    const s = map[insDocId]!;
    expect(s.kind).toBe("insurance_estimate");
    expect(s.status).toBe("parsed");
    if (s.kind === "insurance_estimate") {
      expect(s.claim?.carrierName).toBe("Acme");
      expect(s.claim?.lineItemCount).toBe(3);
      expect(s.claim?.rcvCents).toBe(150000);
    }
  });

  it("measurement parsed → measurement summary from areas", async () => {
    const map = await getDocumentParseSummaries({ tenantId, documentIds: [measDocId] });
    const s = map[measDocId]!;
    if (s.kind === "measurement_report") {
      expect(s.measurement?.squares).toBe(24);
      expect(s.measurement?.pitch).toBe("8/12");
      expect(s.measurement?.ridgeLf).toBe(40);
    } else { throw new Error("wrong kind"); }
  });

  it("low-confidence → status only, null entity", async () => {
    const map = await getDocumentParseSummaries({ tenantId, documentIds: [lowDocId] });
    const s = map[lowDocId]!;
    expect(s.status).toBe("unparsed_low_confidence");
    if (s.kind === "insurance_estimate") expect(s.claim).toBeNull();
  });

  it("empty documentIds → empty map", async () => {
    expect(await getDocumentParseSummaries({ tenantId, documentIds: [] })).toEqual({});
  });
});
