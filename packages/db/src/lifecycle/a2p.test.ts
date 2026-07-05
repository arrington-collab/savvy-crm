import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, integrationConnection, eq } from "../index";
import { upsertTwilioConnection, setTelephonyConnectionStatus } from "./telephony";
import { getA2pRegistration, setA2pRegistration } from "./a2p";

let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  // Required for seal/open in upsertTwilioConnection
  process.env.INTEGRATION_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");

  tenantId = randomUUID();
  otherTenantId = randomUUID();

  await adminDb.insert(tenant).values([
    { id: tenantId, name: "A2P-Test Co", publicKey: `a2p-${tenantId.slice(0, 8)}` },
    { id: otherTenantId, name: "A2P-Other Co", publicKey: `a2p-${otherTenantId.slice(0, 8)}` },
  ]);

  // Seed an ACTIVE twilio connection for tenantId
  await upsertTwilioConnection(tenantId, {
    secret: { accountSid: "ACtest123", authToken: "tok_test" },
    fromNumber: "+14805551234",
  });
  await setTelephonyConnectionStatus(tenantId, "twilio", "active", { verifiedNow: true });
});

afterAll(async () => {
  await adminDb.delete(integrationConnection).where(eq(integrationConnection.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, otherTenantId));
});

it("returns registered=false + empty state for tenant with no connection", async () => {
  const none = await getA2pRegistration(otherTenantId);
  expect(none.registered).toBe(false);
  expect(none.connectionActive).toBe(false);
  expect(none.state.messagingServiceSid).toBeNull();
  expect(none.state.campaignStatus).toBeNull();
  expect(none.state.brandStatus).toBeNull();
});

it("setA2pRegistration merges patch into metadata.a2p", async () => {
  await setA2pRegistration(tenantId, { messagingServiceSid: "MG1", campaignStatus: "verified", brandStatus: "verified" });
  const r = await getA2pRegistration(tenantId);
  expect(r.connectionActive).toBe(true);
  expect(r.state.messagingServiceSid).toBe("MG1");
  expect(r.state.campaignStatus).toBe("verified");
  expect(r.state.brandStatus).toBe("verified");
  expect(r.registered).toBe(true);
});

it("partial patch preserves existing a2p fields", async () => {
  await setA2pRegistration(tenantId, { campaignStatus: "active" });
  const r = await getA2pRegistration(tenantId);
  // messagingServiceSid from prior set should remain
  expect(r.state.messagingServiceSid).toBe("MG1");
  expect(r.state.campaignStatus).toBe("active");
  expect(r.registered).toBe(true);
});

it("getA2pRegistration returns registered=false when campaign status is pending", async () => {
  await setA2pRegistration(tenantId, { campaignStatus: "pending" });
  const r = await getA2pRegistration(tenantId);
  expect(r.connectionActive).toBe(true);
  expect(r.registered).toBe(false);
});
