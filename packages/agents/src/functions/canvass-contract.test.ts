import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, customer, property, lead, document, contractTemplate } from "@savvy/db";
import { makeFakeStorage } from "@savvy/integrations";
import { ContractTemplateRequiredError } from "@savvy/core";
import { storeCanvassContract, emailSignedCopy } from "./canvass-contract";

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
    .values({ tenantId: tId, customerId: custId, propertyId: propId, source: "canvass" })
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
  it("uploads the contract JSON and records a lead-scoped contract document", async () => {
    const storage = makeFakeStorage();
    const r = await storeCanvassContract({ tenantId: tId, leadId, contract }, { storage });
    expect(r).toEqual({ stored: true });
    expect(storage.calls).toEqual([{ op: "put", key: `${tId}/canvass/contract-${contract.integrityHash}.json` }]);

    const docs = await adminDb.select().from(document).where(eq(document.tenantId, tId));
    expect(docs).toHaveLength(1);
    expect(docs[0]!.kind).toBe("contract");
    expect(docs[0]!.customerId).toBe(custId);
    // Lead-scoped so it renders in LeadDocsCard and carries onto the job at conversion.
    expect(docs[0]!.leadId).toBe(leadId);
    expect(docs[0]!.propertyId).toBe(propId);
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

describe("emailSignedCopy", () => {
  function fakeSender() {
    const sent: { to: string; from: string; subject: string; html: string }[] = [];
    return {
      sent,
      async sendEmail(o: { to: string; from: string; subject: string; html: string }) {
        sent.push(o);
        return { id: "em_1" };
      },
    };
  }
  const input = {
    contract: { ...contract, termsText: "RIGHT OF RESCISSION\nProperty Owner may cancel within 72 HOURS of signing." },
    customerEmail: "jane@ho.example",
    customerName: "Jane HO",
    companyName: "Northwind Roofing",
  };

  it("sends the full signed copy with the rescission notice", async () => {
    const email = fakeSender();
    const r = await emailSignedCopy(input, { email, from: "docs@example.com" });
    expect(r).toEqual({ sent: true });
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0]!;
    expect(m.to).toBe("jane@ho.example");
    expect(m.subject).toContain("Insurance Proposal Contract");
    expect(m.html).toContain("RIGHT TO CANCEL");
    expect(m.html).toContain("72 HOURS");
    expect(m.html).toContain("Jane HO");
    expect(m.html).toContain("CLM-1");
  });

  it("fails soft without an email address and never throws on send errors", async () => {
    const r1 = await emailSignedCopy({ ...input, customerEmail: null }, { email: fakeSender(), from: "docs@example.com" });
    expect(r1).toEqual({ sent: false, reason: "no_email" });
    const boom = { async sendEmail() { throw new Error("resend down"); } };
    const r2 = await emailSignedCopy(input, { email: boom, from: "docs@example.com" });
    expect(r2.sent).toBe(false);
    expect(r2.reason).toContain("send_failed");
  });

  // Cell 17b: the CO signed-copy notice gains the no-deductible-waiver (C.R.S.
  // § 6-22-105) and 10-day insurer-decision provisions; non-CO (AZ door-to-door)
  // stays byte-identical to the pre-17b notice.
  it("adds the CO SB38 provisions (6-22-105 + 10-day) for a CO contract", async () => {
    const email = fakeSender();
    await emailSignedCopy({ ...input, state: "CO" }, { email, from: "docs@example.com" });
    const html = email.sent[0]!.html;
    expect(html).toContain("6-22-105"); // no waiver of the insurance deductible
    expect(html).toMatch(/10[\s-]day/i); // insurer-decision window
  });

  it("leaves the AZ / non-CO door-to-door notice unchanged (no CO 6-22-105 provision)", async () => {
    const azEmail = fakeSender();
    await emailSignedCopy({ ...input, state: "AZ" }, { email: azEmail, from: "docs@example.com" });
    const azHtml = azEmail.sent[0]!.html;
    expect(azHtml).toContain("RIGHT TO CANCEL");
    expect(azHtml).toContain("72 HOURS");
    expect(azHtml).not.toContain("6-22-105");
    // Byte-identical to the notice rendered with no state at all (as-is).
    const noneEmail = fakeSender();
    await emailSignedCopy({ ...input, state: null }, { email: noneEmail, from: "docs@example.com" });
    expect(azHtml).toBe(noneEmail.sent[0]!.html);
  });
});

// Cell 17b: SB38 gate on the canvass field-contract path.
const CO_CLAUSES = ["right_to_rescind", "no_deductible_waiver", "ten_day"];

async function gateTenantWithLead(state: string | null): Promise<{ tenantId: string; leadId: string }> {
  const [t] = await adminDb.insert(tenant).values({ name: "CVG", publicKey: `cvg-${Math.random()}`, clerkOrgId: `org_cvg_${Math.random()}` }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Gated HO", email: "g@x.com" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `7 ${state ?? "None"} Rd`, state }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "canvass" }).returning();
  return { tenantId, leadId: l!.id };
}

const gateContract = (hash: string) => ({ ...contract, integrityHash: hash });

describe("storeCanvassContract — SB38 gate (cell 17b)", () => {
  it("throws ContractTemplateRequiredError for a CO lead with no compliant template (storage untouched)", async () => {
    const { tenantId, leadId } = await gateTenantWithLead("CO");
    const storage = makeFakeStorage();
    await expect(
      storeCanvassContract({ tenantId, leadId, contract: gateContract("11".repeat(32)) }, { storage }),
    ).rejects.toBeInstanceOf(ContractTemplateRequiredError);
    expect(storage.calls).toHaveLength(0);
    const docs = await adminDb.select().from(document).where(eq(document.tenantId, tenantId));
    expect(docs).toHaveLength(0);
  });

  it("stores and stamps the compliant template id for a CO lead with a compliant template", async () => {
    const { tenantId, leadId } = await gateTenantWithLead("CO");
    const [tpl] = await adminDb
      .insert(contractTemplate)
      .values({ tenantId, state: "CO", version: 1, name: "SB38", clauses: CO_CLAUSES, status: "active" })
      .returning();
    const r = await storeCanvassContract({ tenantId, leadId, contract: gateContract("22".repeat(32)) }, { storage: makeFakeStorage() });
    expect(r).toEqual({ stored: true });
    const [doc] = await adminDb.select().from(document).where(eq(document.tenantId, tenantId));
    expect(doc!.contractTemplateId).toBe(tpl!.id);
  });

  it("does not gate an AZ lead — stores without a stamp", async () => {
    const { tenantId, leadId } = await gateTenantWithLead("AZ");
    const r = await storeCanvassContract({ tenantId, leadId, contract: gateContract("33".repeat(32)) }, { storage: makeFakeStorage() });
    expect(r).toEqual({ stored: true });
    const [doc] = await adminDb.select().from(document).where(eq(document.tenantId, tenantId));
    expect(doc!.contractTemplateId).toBeNull();
  });
});
