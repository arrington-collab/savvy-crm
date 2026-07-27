import { describe, it, expect } from "vitest";
import { resolveSendContext } from "./send-context";

describe("resolveSendContext", () => {
  it("resolves companyName, tz, and quietHours from tenant defaults", () => {
    const ctx = resolveSendContext({ name: "Acme", settings: {} });
    expect(ctx.companyName).toBe("Acme");
    expect(ctx.tz).toBe("America/Phoenix");
    expect(ctx.quietHours).toEqual({ startHour: 21, endHour: 8 });
  });

  it("respects a settings.finance.timezone override", () => {
    const ctx = resolveSendContext({
      name: "Acme",
      settings: { finance: { timezone: "America/Denver" } },
    });
    expect(ctx.tz).toBe("America/Denver");
  });

  it("does not change the result when a locationId is passed (reserved, unused today)", () => {
    const tenant = { name: "Acme", settings: {} };
    const withoutLocation = resolveSendContext(tenant);
    const withLocation = resolveSendContext(tenant, "loc_123");
    expect(withLocation).toEqual(withoutLocation);
  });
});
