import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, adminDb, user, tenant, appointment, lead, integrationConnection, eq, and } from "@savvy/db";

// The webhook is in middleware PUBLIC, so Clerk does not intercept it.
// VAPI_WEBHOOK_SECRET is set to "test-vapi-secret" in playwright.config.ts webServer.env.
const SECRET = "test-vapi-secret";

test.describe("POST /api/voice/vapi", () => {
  test("401s a wrong secret", async ({ request }) => {
    const res = await request.post("/api/voice/vapi", {
      headers: { "x-vapi-secret": "wrong-secret" },
      data: { message: { type: "end-of-call-report" } },
    });
    expect(res.status()).toBe(401);
  });

  test("401s a missing secret header", async ({ request }) => {
    const res = await request.post("/api/voice/vapi", {
      data: { message: { type: "end-of-call-report" } },
    });
    expect(res.status()).toBe(401);
  });

  test("acks an unknown message type with the correct secret", async ({ request }) => {
    const res = await request.post("/api/voice/vapi", {
      headers: { "x-vapi-secret": "test-vapi-secret" },
      data: { message: { type: "status-update" } },
    });
    expect(res.status()).toBe(200);
  });
});

test("inbound assistant-request returns a tenant-branded live-booking assistant", async ({ request }) => {
  const inboundPhone = `+1480556${String(Math.floor(Math.random() * 9000) + 1000)}`;
  await adminDb.update(tenant).set({ inboundPhone }).where(eq(tenant.id, tenantId));
  const [{ name: tenantName }] = await adminDb
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, tenantId));

  const res = await request.post("/api/voice/vapi", {
    headers: { "x-vapi-secret": SECRET },
    data: {
      message: {
        type: "assistant-request",
        call: { id: `call_${Date.now()}`, metadata: {} },
        phoneNumber: { number: inboundPhone },
        customer: { number: "+14805550123" },
      },
    },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as {
    assistantOverrides?: {
      firstMessage?: string;
      model?: { tools?: { function: { name: string } }[]; messages?: { content: string }[] };
    };
  };
  const ov = json.assistantOverrides!;
  expect(ov.firstMessage).toContain(tenantName);
  const toolNames = ov.model!.tools!.map((t) => t.function.name);
  expect(toolNames).toContain("setCallDetails");
  expect(toolNames).toContain("bookSlot");
  expect(ov.model!.messages![0]!.content).toMatch(/spell/i);
});

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

test("inbound assistant-request resolves tenant by BYO Vapi assistantId", async ({ request }) => {
  // Use a random assistantId to avoid shared-DB collisions across parallel runs.
  const byoAssistantId = `asst_byo_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // Seed an active Vapi integration_connection row directly (no encryption needed
  // for this test — tenantByVapiAssistant only reads metadata.assistantId + status).
  // Secret fields use placeholder values; the test never decrypts them.
  await adminDb
    .insert(integrationConnection)
    .values({
      tenantId,
      provider: "vapi",
      status: "active",
      secretCiphertext: "test-cipher",
      secretIv: "test-iv",
      secretTag: "test-tag",
      keyVersion: 1,
      metadata: { assistantId: byoAssistantId, phoneNumberId: "pn_byo_test" },
    })
    .onConflictDoUpdate({
      target: [integrationConnection.tenantId, integrationConnection.provider],
      set: { status: "active", metadata: { assistantId: byoAssistantId, phoneNumberId: "pn_byo_test" }, updatedAt: new Date() },
    });

  const [{ name: tenantName }] = await adminDb
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, tenantId));

  try {
    // POST an assistant-request carrying the BYO assistant id — no phoneNumber field
    // so the existing tenantByPhone fallback cannot fire; resolution must use assistantId.
    const res = await request.post("/api/voice/vapi", {
      headers: { "x-vapi-secret": SECRET },
      data: {
        message: {
          type: "assistant-request",
          call: { id: `call_byo_${Date.now()}`, metadata: {} },
          assistant: { id: byoAssistantId },
          customer: { number: "+14805550123" },
        },
      },
    });
    expect(res.status()).toBe(200);
    const json = (await res.json()) as {
      assistantOverrides?: {
        firstMessage?: string;
        model?: { tools?: { function: { name: string } }[]; messages?: { content: string }[] };
      };
    };
    const ov = json.assistantOverrides!;
    // The branded assistant for THIS tenant must be returned.
    expect(ov.firstMessage).toContain(tenantName);
    const toolNames = ov.model!.tools!.map((t) => t.function.name);
    expect(toolNames).toContain("setCallDetails");
    expect(toolNames).toContain("bookSlot");
    expect(ov.model!.messages![0]!.content).toMatch(/spell/i);
  } finally {
    // Clean up: remove the seeded vapi connection so subsequent test runs can re-insert.
    await adminDb
      .delete(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "vapi")));
  }
});

// Booking emits async inngest events; rows appear after the route returns.
async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 500));
  }
}

// parseVapiMessage reads call.metadata, message.phoneNumber.number (dialed/tenant),
// message.customer.number (caller), and message.toolCalls[].function.{name,arguments(JSON string)}.
function toolCallBody(
  callId: string,
  toNumber: string,
  fromNumber: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    message: {
      type: "tool-calls",
      call: { id: callId, metadata: {} },
      phoneNumber: { number: toNumber },
      customer: { number: fromNumber },
      toolCalls: [{ id: "tc1", function: { name, arguments: JSON.stringify(args) } }],
    },
  };
}

test("inbound voice: setCallDetails → rep assigned + slots → bookSlot books live", async ({ request }) => {
  // Unique dialed number so this test owns the tenant resolution (tenantByPhone).
  const inboundPhone = `+1480555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const fromNumber = "+14805550199";
  const callId = `call_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // Seed two reps; a zip territory rule routes 85203 → rep B (mirror quick-book.spec.ts).
  const reps = await withTenant(tenantId, async (tx) => {
    const a = (await tx.insert(user).values({ tenantId, name: "VB Ann", email: "", role: "rep", clerkUserId: null }).returning({ id: user.id }))[0]!.id;
    const b = (await tx.insert(user).values({ tenantId, name: "VB Bob", email: "", role: "rep", clerkUserId: null }).returning({ id: user.id }))[0]!.id;
    return { a, b };
  });
  await adminDb
    .update(tenant)
    .set({
      inboundPhone,
      settings: { assignment: { strategy: "territory", territoryRules: [{ zip: "85203", userId: reps.b }] } },
    })
    .where(eq(tenant.id, tenantId));

  // 1) setCallDetails: capture address+zip, create+correlate the lead, assign rep B, offer slots.
  const setRes = await request.post("/api/voice/vapi", {
    headers: { "x-vapi-secret": SECRET },
    data: toolCallBody(callId, inboundPhone, fromNumber, "setCallDetails", {
      name: "Inbound Dale",
      address: "882 W Elm St",
      city: "Mesa",
      zip: "85203",
    }),
  });
  expect(setRes.status()).toBe(200);
  const setJson = (await setRes.json()) as { results: { toolCallId: string; result: { slots?: unknown[] } }[] };
  const slots = setJson.results[0]!.result.slots as { startsAt: string; endsAt: string }[];
  expect(Array.isArray(slots)).toBe(true);
  expect(slots.length).toBeGreaterThanOrEqual(1);

  // The lead was created, correlated by call.id, and assigned to rep B (the territory match).
  const created = await waitFor(async () => {
    const rows = await adminDb
      .select({ id: lead.id, voiceCallId: lead.voiceCallId, assignedUserId: lead.assignedUserId })
      .from(lead)
      .where(and(eq(lead.tenantId, tenantId), eq(lead.voiceCallId, callId)));
    return rows[0];
  });
  expect(created.assignedUserId).toBe(reps.b);

  // 2) bookSlot using a returned slot → live booking.
  const slot = slots[0]!;
  const bookRes = await request.post("/api/voice/vapi", {
    headers: { "x-vapi-secret": SECRET },
    data: toolCallBody(callId, inboundPhone, fromNumber, "bookSlot", {
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    }),
  });
  expect(bookRes.status()).toBe(200);
  const bookJson = (await bookRes.json()) as { results: { result: { booked?: boolean } }[] };
  expect(bookJson.results[0]!.result.booked).toBe(true);

  // A scheduled appointment for rep B now exists.
  const appt = await waitFor(async () => {
    const rows = await adminDb
      .select()
      .from(appointment)
      .where(and(eq(appointment.tenantId, tenantId), eq(appointment.assigneeUserId, reps.b)));
    return rows.find((r) => r.status === "scheduled");
  });
  expect(appt.type).toBe("inspection");
});
