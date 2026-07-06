import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, job, estimate, document, contractTemplate } from "../src/schema/index.js";

// The compliance.contract_template sweep invariant: every stamped contract must
// sit on a CURRENTLY-compliant template, and every sent/accepted CO estimate
// must be stamped. Catches drift the send-time gate cannot (a template that was
// compliant at signing but is later retired / has a clause removed).

const CO_CLAUSES = ["right_to_rescind", "no_deductible_waiver", "ten_day"];
const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };

let cleanId: string;
let badId: string;
let badRefs: Set<string>;

const run = (tenantId: string) => {
  const ctx: EvidenceCtx = { tenantId, db: adminPool, params: {}, window: WINDOW };
  return evidenceChecks["compliance.contract_template"]!(ctx);
};

// Helper: a CO job (customer + CO property + job) returning the job id.
async function coJob(tid: string, state = "CO"): Promise<string> {
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "cc", phone: null }).returning();
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId: tid, customerId: c!.id, address: `addr-${tid}-${Math.round(WINDOW.start.getTime())}-${state}-${Math.random()}`, state })
    .returning();
  const [j] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, stage: "approved" }).returning();
  return j!.id;
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "CT-clean", publicKey: `ct-clean-${Math.random()}`, clerkOrgId: `org_ct_clean_${Math.random()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "CT-bad", publicKey: `ct-bad-${Math.random()}`, clerkOrgId: `org_ct_bad_${Math.random()}` }).returning();
  cleanId = a!.id;
  badId = b!.id;

  // Templates for each tenant.
  const mkTemplate = async (tid: string, over: { state?: string; version?: number; clauses?: string[]; status?: string }) => {
    const [t] = await adminDb
      .insert(contractTemplate)
      .values({ tenantId: tid, state: over.state ?? "CO", version: over.version ?? 1, name: "SB38", clauses: over.clauses ?? CO_CLAUSES, status: over.status ?? "active" })
      .returning();
    return t!.id;
  };

  // CLEAN: a compliant CO estimate + compliant CO contract document, both stamped
  // with an active/complete template.
  const cleanTpl = await mkTemplate(cleanId, {});
  const cleanCo = await coJob(cleanId);
  await adminDb.insert(estimate).values({ tenantId: cleanId, jobId: cleanCo, status: "sent", contractTemplateId: cleanTpl });
  const [cleanCust] = await adminDb.insert(customer).values({ tenantId: cleanId, name: "doc-owner" }).returning();
  await adminDb.insert(document).values({ tenantId: cleanId, customerId: cleanCust!.id, kind: "contract", label: "signed", contractTemplateId: cleanTpl });
  // CLEAN also: an AZ sent estimate with NO stamp — ungated, must not violate.
  const cleanAz = await coJob(cleanId, "AZ");
  await adminDb.insert(estimate).values({ tenantId: cleanId, jobId: cleanAz, status: "sent", contractTemplateId: null });

  // BAD: seed three distinct violations.
  const badRetired = await mkTemplate(badId, { status: "retired", version: 1 }); // drift: was compliant, now retired
  const badMissingClause = await mkTemplate(badId, { status: "active", version: 2, clauses: ["right_to_rescind", "ten_day"] }); // active but missing no_deductible_waiver

  // 1) estimate stamped with a now-retired template (drift).
  const badJob1 = await coJob(badId);
  const [e1] = await adminDb.insert(estimate).values({ tenantId: badId, jobId: badJob1, status: "accepted", contractTemplateId: badRetired }).returning();
  // 2) sent CO estimate with NO stamp (unstamped).
  const badJob2 = await coJob(badId);
  const [e2] = await adminDb.insert(estimate).values({ tenantId: badId, jobId: badJob2, status: "sent", contractTemplateId: null }).returning();
  // 3) contract document stamped with a clause-missing template (drift).
  const [badCust] = await adminDb.insert(customer).values({ tenantId: badId, name: "doc-owner-bad" }).returning();
  const [d1] = await adminDb.insert(document).values({ tenantId: badId, customerId: badCust!.id, kind: "contract", label: "signed", contractTemplateId: badMissingClause }).returning();

  badRefs = new Set([e1!.id, e2!.id, d1!.id]);
});

afterAll(async () => {
  await adminPool.end();
});

describe("compliance.contract_template invariant", () => {
  it("passes for a tenant whose CO contracts are all on compliant templates (AZ unstamped ignored)", async () => {
    const res = await run(cleanId);
    expect(res.status).toBe("pass");
  });

  it("fails and flags drift (retired + clause-missing) and unstamped CO estimates", async () => {
    const res = await run(badId);
    expect(res.status).toBe("fail");
    const refs = new Set(res.refs.map((r) => r.ref));
    for (const id of badRefs) expect(refs.has(id), `expected violation for ${id}`).toBe(true);
    expect(res.refs.length).toBe(3);
  });
});
