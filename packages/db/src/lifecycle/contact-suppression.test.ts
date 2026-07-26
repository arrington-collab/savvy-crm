import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { adminDb, tenant } from "../index";
import { contactSuppression } from "../schema/comms-suppression";
import { isSuppressed, suppress } from "./contact-suppression";

let tenantId: string;
beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Sup-Test", publicKey: `sup-${tenantId.slice(0,8)}` });
});
afterAll(async () => {
  await adminDb.delete(contactSuppression).where(eq(contactSuppression.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("not suppressed by default; suppress() then isSuppressed() true for the phone+channel", async () => {
  expect(await isSuppressed({ tenantId, phoneE164: "+15551230000", channel: "sms" })).toBe(false);
  await suppress({ tenantId, phoneE164: "+15551230000", channel: "sms", reason: "stop", source: "test" });
  expect(await isSuppressed({ tenantId, phoneE164: "+15551230000", channel: "sms" })).toBe(true);
});

it("channel 'all' suppresses both sms and email lookups", async () => {
  await suppress({ tenantId, phoneE164: "+15551239999", email: "x@y.com", channel: "all", reason: "manual", source: "test" });
  expect(await isSuppressed({ tenantId, phoneE164: "+15551239999", channel: "sms" })).toBe(true);
  expect(await isSuppressed({ tenantId, email: "x@y.com", channel: "email" })).toBe(true);
});

it("suppress() is idempotent (second call no-throw, one effective row per key/channel)", async () => {
  await suppress({ tenantId, phoneE164: "+15551235555", channel: "sms", reason: "stop", source: "a" });
  await suppress({ tenantId, phoneE164: "+15551235555", channel: "sms", reason: "stop", source: "b" });
  expect(await isSuppressed({ tenantId, phoneE164: "+15551235555", channel: "sms" })).toBe(true);
});
