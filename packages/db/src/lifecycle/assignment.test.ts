import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { tenant, user, customer, lead, property, job, appointment } from "../schema/index.js";
import { getAssignmentCandidates, getRepSameDayAppts, getSchedulingOffice, recommendAssignee } from "./assignment.js";

const tenantIds: string[] = [];

async function seedBase() {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "AssignTest", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  tenantIds.push(t!.id);
  return t!;
}

afterAll(async () => {
  if (tenantIds.length) {
    // Clean up in FK-safe order
    await adminDb.delete(appointment).where(inArray(appointment.tenantId, tenantIds));
    await adminDb.delete(job).where(inArray(job.tenantId, tenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, tenantIds));
    await adminDb.delete(lead).where(inArray(lead.tenantId, tenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, tenantIds));
    await adminDb.delete(user).where(inArray(user.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("getAssignmentCandidates — base/skills extension", () => {
  it("returns baseLat, baseLng, and skills on the candidate shape", async () => {
    const t = await seedBase();
    const tenantId = t.id;

    await withTenant(tenantId, async (tx) => {
      await tx.insert(user).values({
        tenantId,
        name: "Rep A",
        email: `rep-a-${crypto.randomUUID()}@x.com`,
        role: "rep",
        baseLat: 33.45,
        baseLng: -111.99,
        skills: ["tile", "shingle"],
      });
    });

    const candidates = await withTenant(tenantId, (tx) => getAssignmentCandidates(tx, tenantId));
    expect(candidates.length).toBe(1);
    const c = candidates[0]!;
    expect(c.baseLat).toBeCloseTo(33.45);
    expect(c.baseLng).toBeCloseTo(-111.99);
    expect(c.skills).toEqual(["tile", "shingle"]);
  });

  it("returns null base and empty skills for a rep without them", async () => {
    const t = await seedBase();
    const tenantId = t.id;

    await withTenant(tenantId, async (tx) => {
      await tx.insert(user).values({
        tenantId,
        name: "Rep B",
        email: `rep-b-${crypto.randomUUID()}@x.com`,
        role: "rep",
      });
    });

    const candidates = await withTenant(tenantId, (tx) => getAssignmentCandidates(tx, tenantId));
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.baseLat).toBeNull();
    expect(candidates[0]!.baseLng).toBeNull();
    expect(candidates[0]!.skills).toEqual([]);
  });
});

describe("getRepSameDayAppts", () => {
  it("groups today's scheduled appointments by assignee with property lat/lng", async () => {
    const t = await seedBase();
    const tenantId = t.id;

    let repId: string;
    let apptId: string;

    await withTenant(tenantId, async (tx) => {
      const [rep] = await tx
        .insert(user)
        .values({ tenantId, name: "Rep C", email: `rep-c-${crypto.randomUUID()}@x.com`, role: "rep" })
        .returning();
      repId = rep!.id;

      const [c] = await tx.insert(customer).values({ tenantId, name: "Cust" }).returning();
      const [p] = await tx
        .insert(property)
        .values({ tenantId, customerId: c!.id, address: "1 Test St", lat: 33.5, lng: -112.0 })
        .returning();
      const [j] = await tx
        .insert(job)
        .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" })
        .returning();

      // Appointment today at 10am UTC
      const startsAt = new Date();
      startsAt.setUTCHours(10, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);

      const [a] = await tx
        .insert(appointment)
        .values({
          tenantId,
          jobId: j!.id,
          customerId: c!.id,
          type: "inspection",
          startsAt,
          endsAt,
          assigneeUserId: rep!.id,
          status: "scheduled",
        })
        .returning();
      apptId = a!.id;
    });

    const ref = new Date();
    const apptMap = await withTenant(tenantId, (tx) => getRepSameDayAppts(tx, tenantId, ref));

    expect(apptMap.has(repId!)).toBe(true);
    const appts = apptMap.get(repId!)!;
    expect(appts.length).toBe(1);
    expect(appts[0]!.lat).toBeCloseTo(33.5);
    expect(appts[0]!.lng).toBeCloseTo(-112.0);
    expect(appts[0]!.startsAt).toBeInstanceOf(Date);
  });

  it("excludes appointments on a different UTC day", async () => {
    const t = await seedBase();
    const tenantId = t.id;

    await withTenant(tenantId, async (tx) => {
      const [rep] = await tx
        .insert(user)
        .values({ tenantId, name: "Rep D", email: `rep-d-${crypto.randomUUID()}@x.com`, role: "rep" })
        .returning();
      const [c] = await tx.insert(customer).values({ tenantId, name: "Cust2" }).returning();
      const [p] = await tx
        .insert(property)
        .values({ tenantId, customerId: c!.id, address: "2 Test St", lat: 33.6, lng: -112.1 })
        .returning();
      const [j] = await tx
        .insert(job)
        .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" })
        .returning();

      // Appointment yesterday
      const startsAt = new Date();
      startsAt.setUTCDate(startsAt.getUTCDate() - 1);
      startsAt.setUTCHours(10, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);

      await tx.insert(appointment).values({
        tenantId,
        jobId: j!.id,
        customerId: c!.id,
        type: "inspection",
        startsAt,
        endsAt,
        assigneeUserId: rep!.id,
        status: "scheduled",
      });
    });

    const ref = new Date(); // today
    const apptMap = await withTenant(tenantId, (tx) => getRepSameDayAppts(tx, tenantId, ref));
    // No entries for today
    expect(apptMap.size).toBe(0);
  });
});

describe("getSchedulingOffice", () => {
  it("returns null when no office is configured", async () => {
    const t = await seedBase();
    const office = await getSchedulingOffice(t.id);
    expect(office).toBeNull();
  });

  it("returns the office lat/lng from tenant settings", async () => {
    const t = await seedBase();
    await adminDb
      .update(tenant)
      .set({ settings: { scheduling: { office: { lat: 33.4484, lng: -112.074 } } } })
      .where(eq(tenant.id, t.id));
    const office = await getSchedulingOffice(t.id);
    expect(office).not.toBeNull();
    expect(office!.lat).toBeCloseTo(33.4484);
    expect(office!.lng).toBeCloseTo(-112.074);
  });
});

async function mkTenant(name: string) {
  const [t] = await adminDb.insert(tenant).values({ name, publicKey: `k-${name}-${Date.now()}`, clerkOrgId: `org-${name}-${Date.now()}` }).returning();
  tenantIds.push(t!.id);
  return t!.id;
}
async function mkRep(tenantId: string, name: string) {
  return withTenant(tenantId, async (tx) => {
    const [u] = await tx.insert(user).values({ tenantId, name, email: "", role: "rep", clerkUserId: null }).returning({ id: user.id });
    return u!.id;
  });
}

describe("recommendAssignee", () => {
  it("returns the rep whose zip-territory rule matches", async () => {
    const tid = await mkTenant("rec-zip");
    const a = await mkRep(tid, "Ann");
    const b = await mkRep(tid, "Bob");
    await adminDb.update(tenant).set({ settings: { assignment: { strategy: "territory", territoryRules: [{ zip: "85203", userId: b }] } } }).where(eq(tenant.id, tid));
    const picked = await recommendAssignee(tid, { zip: "85203", city: "Mesa", state: "AZ" });
    expect(picked).toBe(b);
    expect([a, b]).toContain(picked);
  });

  it("falls back to round-robin when no rule matches", async () => {
    const tid = await mkTenant("rec-rr");
    const a = await mkRep(tid, "Ann");
    await adminDb.update(tenant).set({ settings: { assignment: { strategy: "territory", territoryRules: [] } } }).where(eq(tenant.id, tid));
    const picked = await recommendAssignee(tid, { zip: "99999", city: null, state: null });
    expect(picked).toBe(a); // only rep → round-robin returns them
  });

  it("never picks another tenant's rep (RLS)", async () => {
    const t1 = await mkTenant("rec-iso1");
    const t2 = await mkTenant("rec-iso2");
    const foreign = await mkRep(t2, "Foreign");
    await adminDb.update(tenant).set({ settings: { assignment: { strategy: "territory", territoryRules: [{ zip: "85203", userId: foreign }] } } }).where(eq(tenant.id, t1));
    const picked = await recommendAssignee(t1, { zip: "85203", city: "Mesa", state: "AZ" });
    expect(picked).not.toBe(foreign); // t1 has no reps → null
    expect(picked).toBeNull();
  });
});
