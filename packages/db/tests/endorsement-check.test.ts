import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, job, claim } from "../src/schema/index.js";
import { setClaimEndorsement } from "../src/lifecycle/endorsement.js";

// Cell 16: claim.endorsement_no_idle flags any open (needed/requested) mortgage
// endorsement idle > 5 business days. now = window.end (Mon 2026-07-13).
const NOW = new Date("2026-07-13T12:00:00Z");
const WINDOW = { start: new Date(NOW.getTime() - 86_400_000), end: NOW };
let cleanId: string, badId: string;

const run = (tenantId: string) => {
  const ctx: EvidenceCtx = { tenantId, db: adminPool, params: {}, window: WINDOW };
  return evidenceChecks["claim.endorsement_no_idle"]!(ctx);
};

async function claimForTenant(tid: string, over: { status?: string; last?: Date | null; lender?: string | null }): Promise<string> {
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "HO" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `end-${Math.random()}` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "insurance" }).returning();
  const [cl] = await adminDb
    .insert(claim)
    .values({ tenantId: tid, jobId: j!.id, status: "approved", lenderName: over.lender ?? "Wells Fargo", endorsementStatus: over.status ?? "requested", endorsementLastActionAt: over.last ?? null })
    .returning();
  return cl!.id;
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "END-clean", publicKey: `endc-${Math.random()}`, clerkOrgId: `org_endc_${Math.random()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "END-bad", publicKey: `endb-${Math.random()}`, clerkOrgId: `org_endb_${Math.random()}` }).returning();
  cleanId = a!.id;
  badId = b!.id;

  // CLEAN: fresh endorsement (acted 2 business days ago) + a received one (never idle).
  await claimForTenant(cleanId, { status: "requested", last: new Date("2026-07-09T12:00:00Z") }); // Thu → Mon = 2 bd
  await claimForTenant(cleanId, { status: "received", last: new Date("2000-01-01T00:00:00Z") });
  // BAD: an endorsement idle 6 business days (last acted Fri 2026-07-03).
  await claimForTenant(badId, { status: "requested", last: new Date("2026-07-03T12:00:00Z") });
});

afterAll(async () => {
  await adminPool.end();
});

describe("claim.endorsement_no_idle invariant", () => {
  it("passes when open endorsements are within the 5-business-day SLA (received ignored)", async () => {
    const res = await run(cleanId);
    expect(res.status).toBe("pass");
  });

  it("fails (red path) for an endorsement idle beyond 5 business days", async () => {
    const res = await run(badId);
    expect(res.status).toBe("fail");
    expect(res.refs.length).toBe(1);
  });
});

describe("setClaimEndorsement", () => {
  it("advances status + stamps last-action, resetting the idle clock", async () => {
    const clId = await claimForTenant(badId, { status: "requested", last: new Date("2026-07-03T12:00:00Z") });
    const [j] = await adminDb.select({ jobId: claim.jobId }).from(claim).where(eq(claim.id, clId));
    await setClaimEndorsement({ tenantId: badId, jobId: j!.jobId, status: "received", lastActionAt: NOW });
    const [after] = await adminDb.select().from(claim).where(eq(claim.id, clId));
    expect(after!.endorsementStatus).toBe("received");
    expect(after!.endorsementLastActionAt).not.toBeNull();
  });
});
