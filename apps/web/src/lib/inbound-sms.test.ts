// CI-gated: requires Postgres. If ECONNREFUSED locally, this suite is expected
// to fail — rely on CI (same convention as intake.test.ts / sitesnap-ingest.test.ts).
//
// Exercises the Slice B bridge: handleInboundSms accepts an injectable
// OrchestratorStore (defaulting to a real DrizzleOrchestratorStore) so this
// suite can assert the message.inbound publish with an InMemoryStore — no
// orchestrator-side DB writes needed.
import { describe, it, expect, beforeAll } from "vitest";
import { adminDb, tenant, customer } from "@savvy/db";
import { InMemoryStore } from "@savvy/orchestrator";
import { handleInboundSms } from "./inbound-sms";

describe("handleInboundSms — message.inbound bridge", () => {
  let tenantId: string;
  let customerId: string;
  const phone = "+16025550100";

  beforeAll(async () => {
    const [t] = await adminDb
      .insert(tenant)
      .values({ name: "InboundBridgeTest", clerkOrgId: `org_inbound_bridge_${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const [c] = await adminDb
      .insert(customer)
      .values({ tenantId, name: "Bridge Customer", phone })
      .returning();
    customerId = c!.id;
  });

  it("publishes message.inbound with isOptOut:true and the MessageSid idempotency key on STOP", async () => {
    const store = new InMemoryStore();
    await handleInboundSms(
      tenantId,
      { from: phone, body: "STOP", twilioSid: "SM_STOP_1" },
      { store },
    );

    const audit = store.audits.find((a) => a.event.type === "message.inbound");
    expect(audit).toBeDefined();
    expect(audit!.event.idempotencyKey).toBe("message.inbound:SM_STOP_1");
    expect(audit!.event.tenantId).toBe(tenantId);
    expect((audit!.event.payload as { isOptOut: boolean }).isOptOut).toBe(true);
    expect((audit!.event.payload as { customerId: string | null }).customerId).toBe(customerId);
    expect((audit!.event.payload as { channel: string }).channel).toBe("sms");
  });

  it("publishes message.inbound with isOptOut:false for an ordinary reply", async () => {
    const store = new InMemoryStore();
    await handleInboundSms(
      tenantId,
      { from: phone, body: "Yes see you then", twilioSid: "SM_REPLY_1" },
      { store },
    );

    const audit = store.audits.find((a) => a.event.type === "message.inbound");
    expect(audit).toBeDefined();
    expect(audit!.event.idempotencyKey).toBe("message.inbound:SM_REPLY_1");
    expect((audit!.event.payload as { isOptOut: boolean }).isOptOut).toBe(false);
  });

  it("still publishes message.inbound (customerId null) when the phone doesn't match a customer", async () => {
    const store = new InMemoryStore();
    const result = await handleInboundSms(
      tenantId,
      { from: "+16025559999", body: "hi", twilioSid: "SM_NOMATCH_1" },
      { store },
    );

    expect(result.matched).toBe(false);
    const audit = store.audits.find((a) => a.event.type === "message.inbound");
    expect(audit).toBeDefined();
    expect((audit!.event.payload as { customerId: string | null }).customerId).toBeNull();
  });

  it("is idempotent — a second publish with the same MessageSid is a no-op on the store", async () => {
    const store = new InMemoryStore();
    await handleInboundSms(tenantId, { from: phone, body: "hi again", twilioSid: "SM_DUPE_1" }, { store });
    const before = store.audits.length;
    await handleInboundSms(tenantId, { from: phone, body: "hi again", twilioSid: "SM_DUPE_1" }, { store });
    expect(store.audits.length).toBe(before);
  });
});
