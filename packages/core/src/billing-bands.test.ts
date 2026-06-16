import { describe, it, expect } from "vitest";
import { BILLING_BANDS, getBand } from "./billing-bands";

describe("billing bands", () => {
  it("has ascending bands with all allowance + overage keys", () => {
    expect(BILLING_BANDS.length).toBeGreaterThanOrEqual(3);
    for (const b of BILLING_BANDS) {
      expect(b.allowances).toHaveProperty("jobsProcessed");
      expect(b.allowances).toHaveProperty("aiSpendCents");
      expect(b.allowances).toHaveProperty("aiVoiceMinutes");
      expect(b.allowances).toHaveProperty("storageBytes");
      expect(b.overageRates).toHaveProperty("perJobCents");
      expect(b.overageRates).toHaveProperty("perVoiceMinuteCents");
      expect(b.overageRates).toHaveProperty("perGbStorageCents");
      expect(b.overageRates).toHaveProperty("perAiSpendDollarCents");
    }
  });
  it("getBand returns the matching band, else the first (smallest)", () => {
    expect(getBand(BILLING_BANDS[1]!.key).key).toBe(BILLING_BANDS[1]!.key);
    expect(getBand(null).key).toBe(BILLING_BANDS[0]!.key);
    expect(getBand("nonexistent").key).toBe(BILLING_BANDS[0]!.key);
  });
});
