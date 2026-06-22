import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, withTenant, customer, communication, tenant, eq, and } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

async function tenantInboundNumber(): Promise<string> {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  return (t as { inboundPhone?: string | null }).inboundPhone ?? "+15555550000";
}

function rcSmsPayload(to: string, from: string, text: string) {
  return { body: { type: "SMS", direction: "Inbound", from: { phoneNumber: from }, to: [{ phoneNumber: to }], subject: text, id: Date.now() } };
}

test("ringcentral: validation handshake echoes the token", async ({ request }) => {
  const res = await request.post("/api/ringcentral/inbound", { headers: { "Validation-Token": "vt-123" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["validation-token"]).toBe("vt-123");
});

test("ringcentral: inbound STOP logs the comm and opts the customer out", async ({ request }) => {
  const phone = `+1555${Date.now().toString().slice(-7)}`;
  await withTenant(tenantId, (tx) => tx.insert(customer).values({ tenantId, name: "RC Optout", phone }));
  const to = await tenantInboundNumber();

  const res = await request.post("/api/ringcentral/inbound", { data: rcSmsPayload(to, phone, "STOP") });
  expect(res.ok()).toBeTruthy();

  const [c] = await withTenant(tenantId, (tx) => tx.select().from(customer).where(eq(customer.phone, phone)));
  expect(c?.smsOptOut).toBe(true);
  const inbound = await withTenant(tenantId, (tx) =>
    tx.select().from(communication).where(and(eq(communication.from, phone), eq(communication.direction, "inbound"))));
  expect(inbound.length).toBeGreaterThan(0);
});
