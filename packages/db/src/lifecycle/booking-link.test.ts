import { afterAll, describe, it, expect } from "vitest";
import { inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, bookingLink } from "../schema/index.js";
import { createBookingLink, resolveBookingLink } from "./booking-link.js";

const tenantIds: string[] = [];

async function seedTenant() {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "BookingLinkTest", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  tenantIds.push(t!.id);
  return t!;
}

afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(bookingLink).where(inArray(bookingLink.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("createBookingLink + resolveBookingLink", () => {
  it("creates a link and resolves the token", async () => {
    const t = await seedTenant();
    const token = "test.jwt.token";
    const code = await createBookingLink({ tenantId: t.id, token });
    expect(code).toMatch(/^[0-9A-Za-z]{8}$/);
    const resolved = await resolveBookingLink(code);
    expect(resolved).toBe(token);
  });

  it("returns null for an unknown code", async () => {
    const resolved = await resolveBookingLink("XXXXXXXX");
    expect(resolved).toBeNull();
  });

  it("returns null for an expired link", async () => {
    const t = await seedTenant();
    const token = "expired.token";
    const expiresAt = new Date(Date.now() - 1000); // 1 second in the past
    const code = await createBookingLink({ tenantId: t.id, token, expiresAt });
    const resolved = await resolveBookingLink(code);
    expect(resolved).toBeNull();
  });

  it("resolves a link with null expiresAt (never expires)", async () => {
    const t = await seedTenant();
    const token = "no-expiry.token";
    const code = await createBookingLink({ tenantId: t.id, token, expiresAt: null });
    const resolved = await resolveBookingLink(code);
    expect(resolved).toBe(token);
  });
});
