import { test, expect } from "vitest";
import { makeFakeStripe } from "./stripe";

test("fake stripe creates a checkout session + parses webhook events", async () => {
  const fake = makeFakeStripe();
  const s = await fake.createCheckoutSession({
    connectedAccountId: "acct_1", amountCents: 50000, invoiceId: "inv1", tenantId: "t1",
    description: "INV-000001", successUrl: "https://x/ok", cancelUrl: "https://x/no",
  });
  expect(s.id).toMatch(/^cs_fake_/);
  expect(s.url).toContain("http");
  expect(fake.calls[0]).toMatchObject({ op: "checkout", connectedAccountId: "acct_1", amountCents: 50000 });

  const evt = fake.constructWebhookEvent(JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_1" } } }), "sig");
  expect(evt.type).toBe("checkout.session.completed");
});
