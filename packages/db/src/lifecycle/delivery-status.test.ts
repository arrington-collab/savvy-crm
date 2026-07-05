import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, communication, eq } from "../index";
import { applyDeliveryReceipt } from "./delivery-status";

let tenantId: string; let sid: string;
beforeAll(async () => {
  tenantId = randomUUID(); sid = `SM${randomUUID().slice(0, 10)}`;
  await adminDb.insert(tenant).values({ id: tenantId, name: "DS Co", publicKey: `ds-${tenantId.slice(0,8)}` });
  await adminDb.insert(communication).values({ tenantId, channel: "sms", direction: "outbound", to: "+15551230000", body: "hi", twilioSid: sid });
});
afterAll(async () => {
  await adminDb.delete(communication).where(eq(communication.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("updates delivery_status + error_code by twilio_sid", async () => {
  const r = await applyDeliveryReceipt({ twilioSid: sid, status: "delivered" });
  expect(r.updated).toBe(1);
  const [row] = await adminDb.select().from(communication).where(eq(communication.twilioSid, sid));
  expect(row!.deliveryStatus).toBe("delivered");
});
it("records error code on failure", async () => {
  await applyDeliveryReceipt({ twilioSid: sid, status: "undelivered", errorCode: "30007" });
  const [row] = await adminDb.select().from(communication).where(eq(communication.twilioSid, sid));
  expect(row!.deliveryStatus).toBe("undelivered");
  expect(row!.deliveryErrorCode).toBe("30007");
});
it("returns 0 for an unknown sid (no throw)", async () => {
  const r = await applyDeliveryReceipt({ twilioSid: "SMnope", status: "delivered" });
  expect(r.updated).toBe(0);
});
