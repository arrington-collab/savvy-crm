import { describe, it, expect } from "vitest";
import { attachOrCreateLeadClaim, adminDb, claim, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

const parsed = {
  carrierName: "State Farm", claimNumber: "C-9", acvCents: 800000, rcvCents: 1000000, deductibleCents: 200000,
  lineItems: [{ description: "shingles", quantity: 25, unitPriceCents: null, amountCents: 750000 }], parseConfidence: 0.9,
};

describe("attachOrCreateLeadClaim", () => {
  it("creates a lead-scoped claim shell when the lead has none", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const res = await attachOrCreateLeadClaim({ tenantId, leadId, propertyId, ...parsed });
    expect(res.created).toBe(true);
    const [c] = await adminDb.select().from(claim).where(eq(claim.id, res.claimId));
    expect(c!.leadId).toBe(leadId);
    expect(c!.jobId).toBeNull();
    expect(c!.status).toBe("filed");
    expect(c!.rcvCents).toBe(1000000);
    expect((c!.lineItems as unknown[]).length).toBe(1);
  });

  it("attaches to an existing lead claim WITHOUT overwriting a human-confirmed field", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    // Human already set the carrier + left acv null.
    const [existing] = await adminDb.insert(claim).values({ tenantId, leadId, propertyId, carrierName: "Allstate (confirmed)" }).returning();

    const res = await attachOrCreateLeadClaim({ tenantId, leadId, propertyId, ...parsed });
    expect(res.created).toBe(false);
    expect(res.claimId).toBe(existing!.id);
    const [c] = await adminDb.select().from(claim).where(eq(claim.id, existing!.id));
    expect(c!.carrierName).toBe("Allstate (confirmed)"); // preserved, NOT overwritten by "State Farm"
    expect(c!.acvCents).toBe(800000);                    // filled (was null)
    expect(c!.parseConfidence).toBeCloseTo(0.9);         // always written
    expect((c!.lineItems as unknown[]).length).toBe(1);  // always written
  });

  it("re-parse cannot clobber human-confirmed claim fields (RED PATH #3)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    // First parse populates the claim.
    await attachOrCreateLeadClaim({ tenantId, leadId, propertyId, carrierName: "Parsed Co", claimNumber: "P-1", acvCents: 111, rcvCents: 222, deductibleCents: 100, lineItems: [{ description: "x", quantity: 1, unitPriceCents: null, amountCents: 1 }], parseConfidence: 0.9 });
    // Human confirms/edits carrier + acv on the claim.
    await adminDb.update(claim).set({ carrierName: "Human Co", acvCents: 999 }).where(eq(claim.leadId, leadId));
    // Re-parse with DIFFERENT extracted values.
    await attachOrCreateLeadClaim({ tenantId, leadId, propertyId, carrierName: "Parsed Again", claimNumber: "P-2", acvCents: 555, rcvCents: 777, deductibleCents: 50, lineItems: [{ description: "a", quantity: 1, unitPriceCents: null, amountCents: 1 }, { description: "b", quantity: 1, unitPriceCents: null, amountCents: 1 }, { description: "c", quantity: 1, unitPriceCents: null, amountCents: 1 }], parseConfidence: 0.95 });
    const [row] = await adminDb.select().from(claim).where(eq(claim.leadId, leadId));
    expect(row!.carrierName).toBe("Human Co"); // confirmed value preserved
    expect(row!.acvCents).toBe(999);           // confirmed value preserved
    expect(Array.isArray(row!.lineItems) ? row!.lineItems.length : 0).toBe(3); // lineItems refreshed
    expect(row!.parseConfidence).toBeCloseTo(0.95); // confidence refreshed
  });
});
