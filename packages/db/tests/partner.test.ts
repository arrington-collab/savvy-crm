import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { partner, partnerMergeCandidate } from "../src/schema/partner.js";
import { customer, property, lead } from "../src/schema/crm.js";
import { makeTenant } from "./helpers.js";
import {
  findOrCreatePartner,
  searchPartners,
  backfillPartnerAttribution,
  resolveMergeCandidate,
} from "../src/lifecycle/partner.js";
import { createLeadForTenant } from "../src/lifecycle/lead-intake.js";

/** Seed a legacy partner-class lead via admin (bypasses intake validation), as pre-0097 data. */
async function seedLegacyLead(tenantId: string, source: string, sourceDetail: unknown): Promise<string> {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Legacy Customer" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "9 Legacy Ln" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source, sourceDetail }).returning();
  return l!.id;
}

const intakeBase = { name: "Homeowner", phone: "6025550100", address: "123 Main St, Phoenix AZ" };

describe("findOrCreatePartner", () => {
  it("creates once and matches normalized name+org variants", async () => {
    const { tenantId } = await makeTenant();
    const r1 = await findOrCreatePartner(tenantId, { name: "Jane Smith", org: "RE/MAX", class: "realtor" });
    const r2 = await findOrCreatePartner(tenantId, { name: "jane   smith", org: "RE-MAX", class: "realtor" });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.id).toBe(r1.id);
    const rows = await adminDb.select().from(partner).where(eq(partner.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.class).toBe("realtor");
    expect(rows[0]!.status).toBe("active");
  });

  it("same name at a different org is a DIFFERENT partner", async () => {
    const { tenantId } = await makeTenant();
    const a = await findOrCreatePartner(tenantId, { name: "Jane Smith", org: "RE/MAX", class: "realtor" });
    const b = await findOrCreatePartner(tenantId, { name: "Jane Smith", org: "Keller Williams", class: "realtor" });
    expect(b.id).not.toBe(a.id);
  });

  it("is tenant-scoped: same partner key in two tenants → two records", async () => {
    const { tenantId: t1 } = await makeTenant();
    const { tenantId: t2 } = await makeTenant();
    const a = await findOrCreatePartner(t1, { name: "Jane Smith", org: "RE/MAX", class: "realtor" });
    const b = await findOrCreatePartner(t2, { name: "Jane Smith", org: "RE/MAX", class: "realtor" });
    expect(b.id).not.toBe(a.id);
    expect(b.created).toBe(true);
  });
});

describe("searchPartners (typeahead)", () => {
  it("matches name or org fragments, tenant-scoped, excludes archived", async () => {
    const { tenantId } = await makeTenant();
    const { tenantId: otherTenant } = await makeTenant();
    await findOrCreatePartner(tenantId, { name: "Jane Smith", org: "RE/MAX", class: "realtor" });
    await findOrCreatePartner(tenantId, { name: "Acme Insurance", class: "insurance_agent" });
    await findOrCreatePartner(otherTenant, { name: "Jane Smith", org: "RE/MAX", class: "realtor" });
    const archived = await findOrCreatePartner(tenantId, { name: "Gone Guy", class: "other" });
    await adminDb.update(partner).set({ status: "archived" }).where(eq(partner.id, archived.id));

    const byName = await searchPartners(tenantId, "jane");
    expect(byName).toHaveLength(1);
    expect(byName[0]!.name).toBe("Jane Smith");

    const byOrg = await searchPartners(tenantId, "re/max");
    expect(byOrg).toHaveLength(1);

    const gone = await searchPartners(tenantId, "gone");
    expect(gone).toHaveLength(0);
  });
});

describe("partner RLS isolation", () => {
  it("cross-tenant reads return nothing", async () => {
    const { tenantId: t1 } = await makeTenant();
    const { tenantId: t2 } = await makeTenant();
    await findOrCreatePartner(t1, { name: "Jane Smith", org: "RE/MAX", class: "realtor" });
    const visible = await withTenant(t2, (tx) => tx.select().from(partner));
    expect(visible).toHaveLength(0);
    const own = await withTenant(t1, (tx) => tx.select().from(partner));
    expect(own).toHaveLength(1);
  });
});

describe("lead intake partner attribution", () => {
  it("inline partner: creates once and stamps lead.partner_id", async () => {
    const { tenantId } = await makeTenant();
    const leadId1 = await createLeadForTenant(tenantId, {
      ...intakeBase, source: "realtor", partner: { name: "Jane Smith", org: "RE/MAX" },
    } as never);
    const leadId2 = await createLeadForTenant(tenantId, {
      ...intakeBase, name: "Second Homeowner", phone: "6025550101", address: "125 Main St, Phoenix AZ",
      source: "realtor", partner: { name: "JANE SMITH", org: "re-max" },
    } as never);
    const [l1] = await adminDb.select().from(lead).where(eq(lead.id, leadId1));
    const [l2] = await adminDb.select().from(lead).where(eq(lead.id, leadId2));
    expect(l1!.partnerId).toBeTruthy();
    expect(l2!.partnerId).toBe(l1!.partnerId);
    const partners = await adminDb.select().from(partner).where(eq(partner.tenantId, tenantId));
    expect(partners).toHaveLength(1);
  });

  it("partnerId pick: stamps the lead directly", async () => {
    const { tenantId } = await makeTenant();
    const p = await findOrCreatePartner(tenantId, { name: "Acme Insurance", class: "insurance_agent" });
    const leadId = await createLeadForTenant(tenantId, {
      ...intakeBase, source: "insurance_agent", partnerId: p.id,
    } as never);
    const [l] = await adminDb.select().from(lead).where(eq(lead.id, leadId));
    expect(l!.partnerId).toBe(p.id);
  });
});

describe("backfillPartnerAttribution", () => {
  it("folds free-text variants into ONE partner and stamps the leads", async () => {
    const { tenantId } = await makeTenant();
    const a = await seedLegacyLead(tenantId, "realtor", { name: "Jane Smith", brokerage: "RE/MAX" });
    const b = await seedLegacyLead(tenantId, "realtor", { name: "jane smith", brokerage: "RE-MAX" });
    const c = await seedLegacyLead(tenantId, "insurance_agent", { agency: "Acme Insurance LLC" });
    const d = await seedLegacyLead(tenantId, "partner", { name: "Bob's Gutters" });

    const result = await backfillPartnerAttribution(tenantId);
    expect(result.attributed).toBe(4);

    const partners = await adminDb.select().from(partner).where(eq(partner.tenantId, tenantId));
    expect(partners).toHaveLength(3); // jane (one), acme, bob's

    const rows = await adminDb.select().from(lead).where(eq(lead.tenantId, tenantId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a)!.partnerId).toBeTruthy();
    expect(byId.get(a)!.partnerId).toBe(byId.get(b)!.partnerId);
    expect(byId.get(c)!.partnerId).toBeTruthy();
    expect(byId.get(d)!.partnerId).toBeTruthy();

    const acme = partners.find((p) => p.class === "insurance_agent");
    expect(acme!.name).toBe("Acme Insurance LLC");
  });

  it("is idempotent and skips unattributable leads (null detail)", async () => {
    const { tenantId } = await makeTenant();
    await seedLegacyLead(tenantId, "realtor", { name: "Jane Smith" });
    await seedLegacyLead(tenantId, "realtor", null);
    const r1 = await backfillPartnerAttribution(tenantId);
    const r2 = await backfillPartnerAttribution(tenantId);
    expect(r1.attributed).toBe(1);
    expect(r1.skipped).toBe(1);
    expect(r2.attributed).toBe(0);
    const partners = await adminDb.select().from(partner).where(eq(partner.tenantId, tenantId));
    expect(partners).toHaveLength(1);
  });

  it("same name at different orgs → two partners + a pending merge candidate, never silently merged", async () => {
    const { tenantId } = await makeTenant();
    await seedLegacyLead(tenantId, "realtor", { name: "Jane Smith", brokerage: "RE/MAX" });
    await seedLegacyLead(tenantId, "realtor", { name: "Jane Smith", brokerage: "Keller Williams" });
    await backfillPartnerAttribution(tenantId);

    const partners = await adminDb.select().from(partner).where(eq(partner.tenantId, tenantId));
    expect(partners).toHaveLength(2);

    const candidates = await adminDb.select().from(partnerMergeCandidate)
      .where(and(eq(partnerMergeCandidate.tenantId, tenantId), eq(partnerMergeCandidate.status, "pending")));
    expect(candidates).toHaveLength(1);
  });
});

describe("resolveMergeCandidate", () => {
  async function seedCandidatePair(tenantId: string) {
    await seedLegacyLead(tenantId, "realtor", { name: "Jane Smith", brokerage: "RE/MAX" });
    await seedLegacyLead(tenantId, "realtor", { name: "Jane Smith", brokerage: "Keller Williams" });
    await backfillPartnerAttribution(tenantId);
    const [cand] = await adminDb.select().from(partnerMergeCandidate).where(eq(partnerMergeCandidate.tenantId, tenantId));
    return cand!;
  }

  it("merge: repoints leads to the kept partner and archives the other", async () => {
    const { tenantId } = await makeTenant();
    const cand = await seedCandidatePair(tenantId);
    await resolveMergeCandidate(tenantId, { candidateId: cand.id, action: "merge" });

    const leads = await adminDb.select().from(lead).where(eq(lead.tenantId, tenantId));
    expect(new Set(leads.map((l) => l.partnerId)).size).toBe(1);
    expect(leads[0]!.partnerId).toBe(cand.partnerAId);

    const [merged] = await adminDb.select().from(partner).where(eq(partner.id, cand.partnerBId));
    expect(merged!.status).toBe("archived");

    const [after] = await adminDb.select().from(partnerMergeCandidate).where(eq(partnerMergeCandidate.id, cand.id));
    expect(after!.status).toBe("merged");
  });

  it("keep_separate: both partners stay active, candidate closed", async () => {
    const { tenantId } = await makeTenant();
    const cand = await seedCandidatePair(tenantId);
    await resolveMergeCandidate(tenantId, { candidateId: cand.id, action: "keep_separate" });
    const partners = await adminDb.select().from(partner).where(eq(partner.tenantId, tenantId));
    expect(partners.filter((p) => p.status === "active")).toHaveLength(2);
    const [after] = await adminDb.select().from(partnerMergeCandidate).where(eq(partnerMergeCandidate.id, cand.id));
    expect(after!.status).toBe("kept_separate");
  });
});

describe("evidence: partner.attribution", () => {
  const run = (tenantId: string) => {
    const ctx: EvidenceCtx = {
      tenantId, db: adminPool, params: {},
      window: { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) },
    };
    return evidenceChecks["partner.attribution"]!(ctx);
  };

  it("passes when every partner-class lead carries partner_id; fails on a bare one", async () => {
    const { tenantId: cleanT } = await makeTenant();
    await createLeadForTenant(cleanT, { ...intakeBase, source: "realtor", partner: { name: "Jane Smith" } } as never);
    const clean = await run(cleanT);
    expect(clean.status).toBe("pass");

    const { tenantId: badT } = await makeTenant();
    await seedLegacyLead(badT, "realtor", { name: "Free Text Rita" });
    const bad = await run(badT);
    expect(bad.status).toBe("fail");
  });
});
