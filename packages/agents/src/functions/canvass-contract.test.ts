import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, customer, property, lead, document } from "@savvy/db";
import { makeFakeStorage } from "@savvy/integrations";
import { storeCanvassContract } from "./canvass-contract";

let tId: string, custId: string, propId: string, leadId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "CV", publicKey: "cv", clerkOrgId: "org_cv" }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "Jane HO", email: "jane@x.com" }).returning();
  custId = c!.id;
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: custId, address: "12 Elm St" }).returning();
  propId = p!.id;
  const [l] = await adminDb
    .insert(lead)
    .values({ tenantId: tId, customerId: custId, propertyId: propId, source: "door-knocking" })
    .returning();
  leadId = l!.id;
});

afterAll(async () => {
  await adminDb.delete(document).where(eq(document.tenantId, tId));
  await adminDb.delete(lead).where(eq(lead.tenantId, tId));
  await adminDb.delete(property).where(eq(property.tenantId, tId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

const contract = {
  kind: "insurance" as const,
  document: "Insurance Proposal Contract",
  fields: { "Claim #": "CLM-1", "Deductible ($)": "2500" },
  scopeItems: ["Final inspection"],
  rep: "Marcus R.",
  signedAt: "2026-07-04T20:00:00.000Z",
  consentElectronic: true as const,
  integrityHash: "ab".repeat(32),
  signaturePng: "data:image/png;base64,iVBORw0KGgo=",
};

describe("storeCanvassContract", () => {
  it("uploads the contract JSON and records a contract document", async () => {
    const storage = makeFakeStorage();
    const r = await storeCanvassContract({ tenantId: tId, leadId, contract }, { storage });
    expect(r).toEqual({ stored: true });
    expect(storage.calls).toEqual([{ op: "put", key: `${tId}/canvass/contract-${contract.integrityHash}.json` }]);

    const docs = await adminDb.select().from(document).where(eq(document.tenantId, tId));
    expect(docs).toHaveLength(1);
    expect(docs[0]!.kind).toBe("contract");
    expect(docs[0]!.customerId).toBe(custId);
    expect(docs[0]!.label).toBe("Insurance Proposal Contract");
    expect(docs[0]!.source).toBe("savvy");
  });

  it("is idempotent on the integrity hash (replay stores nothing)", async () => {
    const storage = makeFakeStorage();
    const r = await storeCanvassContract({ tenantId: tId, leadId, contract }, { storage });
    expect(r).toEqual({ stored: false, reason: "already_stored" });
    expect(storage.calls).toHaveLength(0);
    const docs = await adminDb.select().from(document).where(eq(document.tenantId, tId));
    expect(docs).toHaveLength(1);
  });

  it("reports a missing lead without touching storage", async () => {
    const storage = makeFakeStorage();
    const r = await storeCanvassContract(
      {
        tenantId: tId,
        leadId: "00000000-0000-0000-0000-000000000000",
        contract: { ...contract, integrityHash: "cd".repeat(32) },
      },
      { storage },
    );
    expect(r).toEqual({ stored: false, reason: "lead_not_found" });
    expect(storage.calls).toHaveLength(0);
  });
});
