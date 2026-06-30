import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { pool } from "../src/client.js";
import { tenant, integrationConnection } from "../src/schema/index.js";
import {
  upsertVapiConnection, getVapiConnection, getVapiSecret, resolveVoiceCreds,
  setTelephonyConnectionStatus, setTelephonyMode,
} from "../src/lifecycle/telephony.js";

let tid: string;
beforeAll(async () => {
  process.env.INTEGRATION_SECRET_KEY = Buffer.alloc(32, 5).toString("base64");
  const [t] = await adminDb.insert(tenant).values({ name: "VAPI-LC", publicKey: "vapi-lc", clerkOrgId: "org_vapi_lc" }).returning();
  tid = t!.id;
});
afterAll(async () => {
  await adminDb.delete(integrationConnection).where(eq(integrationConnection.tenantId, tid));
  await adminDb.delete(tenant).where(eq(tenant.id, tid));
  await pool.end();
  await adminPool.end();
});

describe("vapi lifecycle", () => {
  it("upserts without exposing the apiKey, decrypts server-side", async () => {
    await upsertVapiConnection(tid, { secret: { apiKey: "vapi_secret_key" }, assistantId: "asst_1", phoneNumberId: "pn_1" });
    const view = await getVapiConnection(tid);
    expect(view!.status).toBe("pending");
    expect(view!.assistantId).toBe("asst_1");
    expect(JSON.stringify(view)).not.toContain("vapi_secret_key");
    expect(await getVapiSecret(tid)).toEqual({ apiKey: "vapi_secret_key" });
  });

  it("resolveVoiceCreds: platform when mode=platform", async () => {
    process.env.VAPI_API_KEY = "envkey";
    process.env.VAPI_ASSISTANT_ID = "envasst";
    process.env.VAPI_PHONE_NUMBER_ID = "envpn";
    await setTelephonyMode(tid, "platform");
    expect(await resolveVoiceCreds(tid)).toEqual({ source: "platform", vapi: { apiKey: "envkey", assistantId: "envasst", phoneNumberId: "envpn" } });
  });

  it("resolveVoiceCreds: tenant when byo + active", async () => {
    await setTelephonyConnectionStatus(tid, "vapi", "active");
    await setTelephonyMode(tid, "byo");
    expect(await resolveVoiceCreds(tid)).toEqual({ source: "tenant", vapi: { apiKey: "vapi_secret_key", assistantId: "asst_1", phoneNumberId: "pn_1" } });
  });

  it("resolveVoiceCreds: inactive when byo + not active", async () => {
    await setTelephonyConnectionStatus(tid, "vapi", "disabled");
    await setTelephonyMode(tid, "byo");
    expect(await resolveVoiceCreds(tid)).toEqual({ source: "inactive" });
  });
});
