import { test, expect } from "@playwright/test";

// The webhook is in middleware PUBLIC, so Clerk does not intercept it.
// VAPI_WEBHOOK_SECRET is set to "test-vapi-secret" in playwright.config.ts webServer.env.
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
