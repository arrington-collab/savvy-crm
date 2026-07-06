import { describe, expect, it } from "vitest";
import { dormantFinancing, makeFakeFinancing } from "./financing";

describe("dormantFinancing (no vendor chosen)", () => {
  it("offers no apply link and ingests no webhook", async () => {
    expect(await dormantFinancing.applyLink({ estimateId: "e1", amountCents: 2_000_000, tenantId: "t1" })).toBeNull();
    expect(dormantFinancing.parseWebhook({ id: "x", status: "approved" })).toBeNull();
  });
});

describe("makeFakeFinancing (test double behind the seam)", () => {
  it("returns a link and maps a webhook status to the neutral enum", async () => {
    const f = makeFakeFinancing();
    const link = await f.applyLink({ estimateId: "e1", amountCents: 2_000_000, tenantId: "t1" });
    expect(link?.url).toContain("e1");
    const parsed = f.parseWebhook({ externalRef: "app_1", status: "accepted" });
    expect(parsed).toEqual({ externalRef: "app_1", status: "approved" }); // no credit data, status only
  });
});
