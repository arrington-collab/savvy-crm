import { beforeAll, describe, expect, it } from "vitest";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead } from "../src/schema/index.js";

const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const run = (checkKey: string, tenantId: string) => {
  const ctx: EvidenceCtx = { tenantId, db: adminPool, params: {}, window: WINDOW };
  return evidenceChecks[checkKey]!(ctx);
};

async function mkLead(tid: string, source: string | null) {
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}` })
    .returning();
  const [l] = await adminDb
    .insert(lead)
    .values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source, status: "new" })
    .returning();
  return l!.id;
}

let cleanId: string;
let badId: string;

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "src-clean", publicKey: `sc-${Date.now()}`, clerkOrgId: `org_sc_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "src-bad", publicKey: `sb-${Date.now()}`, clerkOrgId: `org_sb_${Date.now()}` }).returning();
  cleanId = a!.id;
  badId = b!.id;

  // Clean tenant: a valid manual source (referral) and a machine source — both exempt/pass.
  await mkLead(cleanId, "referral");
  await mkLead(cleanId, "web");
  await mkLead(cleanId, "inbound_call");

  // Bad tenant: null source and an unknown/legacy source string — both violations.
  await mkLead(badId, null);
  await mkLead(badId, "some-legacy-value");
});

describe("lead.source_taxonomy evidence", () => {
  it("passes when every lead has a recognized source (manual or machine)", async () => {
    const r = await run("lead.source_taxonomy", cleanId);
    expect(r.status).toBe("pass");
    expect(r.refs).toEqual([]);
  });

  it("fails when a lead has a null or unrecognized source", async () => {
    const r = await run("lead.source_taxonomy", badId);
    expect(r.status).toBe("fail");
    expect(r.refs.length).toBe(2);
  });
});
