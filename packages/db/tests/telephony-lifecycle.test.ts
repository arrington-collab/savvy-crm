import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { pool } from "../src/client.js";
import { tenant, integrationConnection } from "../src/schema/index.js";
import {
  getTelephonyMode, setTelephonyMode,
  upsertTwilioConnection, getTelephonyConnection, getTwilioSecret,
  setTelephonyConnectionStatus, requestManagedTelephonySetup, disconnectTelephony,
  listManagedSetupRequests,
} from "../src/lifecycle/telephony.js";

let tid: string;

beforeAll(async () => {
  process.env.INTEGRATION_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
  const [t] = await adminDb.insert(tenant).values({ name: "TEL-LC", publicKey: "tel-lc", clerkOrgId: "org_tel_lc" }).returning();
  tid = t!.id;
});

afterAll(async () => {
  await adminDb.delete(integrationConnection).where(eq(integrationConnection.tenantId, tid));
  await adminDb.delete(tenant).where(eq(tenant.id, tid));
  await pool.end();
  await adminPool.end();
});

describe("telephony lifecycle", () => {
  it("defaults mode to platform and can flip to byo", async () => {
    expect(await getTelephonyMode(tid)).toBe("platform");
    await setTelephonyMode(tid, "byo");
    expect(await getTelephonyMode(tid)).toBe("byo");
  });

  it("upserts a twilio connection without exposing the secret", async () => {
    await upsertTwilioConnection(tid, {
      secret: { accountSid: "ACxxx", authToken: "tok_secret_1234" },
      fromNumber: "+14805551212",
    });
    const view = await getTelephonyConnection(tid, "twilio");
    expect(view).not.toBeNull();
    expect(view!.status).toBe("pending");
    expect(view!.fromNumber).toBe("+14805551212");
    expect(JSON.stringify(view)).not.toContain("tok_secret_1234");
  });

  it("decrypts the secret server-side", async () => {
    expect(await getTwilioSecret(tid)).toEqual({ accountSid: "ACxxx", authToken: "tok_secret_1234" });
  });

  it("activates on verify and stamps lastVerifiedAt", async () => {
    await setTelephonyConnectionStatus(tid, "twilio", "active", { verifiedNow: true });
    const view = await getTelephonyConnection(tid, "twilio");
    expect(view!.status).toBe("active");
    expect(view!.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("records a managed setup request and lists it for ops", async () => {
    await requestManagedTelephonySetup(tid, "twilio", { requestedBy: "user-1", feeNote: "$199 setup" });
    const view = await getTelephonyConnection(tid, "twilio");
    expect(view!.status).toBe("setup_requested");
    expect(view!.metadata.requestedBy).toBe("user-1");
    const ops = await listManagedSetupRequests();
    expect(ops.some((r) => r.tenantId === tid && r.feeNote === "$199 setup")).toBe(true);
  });

  it("disconnects", async () => {
    await disconnectTelephony(tid, "twilio");
    expect((await getTelephonyConnection(tid, "twilio"))!.status).toBe("disabled");
  });
});
