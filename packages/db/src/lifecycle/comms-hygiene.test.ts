import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, job, property, communication, withTenant, eq, and } from "../index";
import { createBookingLink, createStatusLink, resolveBookingLink, claimCommunication } from "../index";

async function seedTenant() {
  const [t] = await adminDb.insert(tenant).values({ name: "C7", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  return t!.id;
}
async function seedJob(tenantId: string) {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 A St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { customerId: c!.id, jobId: j!.id };
}

describe("short-link kinds", () => {
  it("createStatusLink resolves to a status kind; createBookingLink stays booking", async () => {
    const tenantId = await seedTenant();
    const sCode = await createStatusLink({ tenantId, token: "status-jwt-123" });
    const bCode = await createBookingLink({ tenantId, token: "book-tok-456" });
    expect(await resolveBookingLink(sCode)).toEqual({ token: "status-jwt-123", kind: "status" });
    expect(await resolveBookingLink(bCode)).toEqual({ token: "book-tok-456", kind: "booking" });
    expect(await resolveBookingLink("nope")).toBeNull();
  });
});

describe("claimCommunication", () => {
  it("first claim inserts, second identical claim returns null (idempotent)", async () => {
    const tenantId = await seedTenant();
    const { customerId, jobId } = await seedJob(tenantId);
    const base = { tenantId, jobId, customerId, channel: "sms" as const, direction: "outbound" as const, to: "+15551230000", body: "hi", dedupeKey: "stage:sms:+15551230000:evt-1" };
    const first = await claimCommunication(base);
    expect(first).not.toBeNull();
    const second = await claimCommunication(base);
    expect(second).toBeNull();
    const rows = await withTenant(tenantId, (tx) => tx.select().from(communication).where(and(eq(communication.tenantId, tenantId), eq(communication.dedupeKey, base.dedupeKey))));
    expect(rows).toHaveLength(1);
  });
  it("different dedupeKey → both succeed", async () => {
    const tenantId = await seedTenant();
    const { customerId, jobId } = await seedJob(tenantId);
    const a = await claimCommunication({ tenantId, jobId, customerId, channel: "email", direction: "outbound", to: "a@x.com", body: "b", dedupeKey: "stage:email:a@x.com:evt-9" });
    const b = await claimCommunication({ tenantId, jobId, customerId, channel: "email", direction: "outbound", to: "a@x.com", body: "b", dedupeKey: "stage:email:a@x.com:evt-10" });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});
