import { describe, it, expect } from "vitest";
import { computeBill } from "./billing";
import { getBand } from "./billing-bands";

const band = getBand("starter"); // price 49900; allow {50 jobs, 5000c ai, 500 min, 10GB}
const GB = 1024 ** 3;

describe("computeBill", () => {
  it("base only when under all allowances", () => {
    const b = computeBill({ jobsProcessed: 10, aiSpendCents: 1000, aiVoiceMinutes: 100, storageBytes: GB }, band);
    expect(b.basePriceCents).toBe(49900);
    expect(b.overageTotalCents).toBe(0);
    expect(b.totalCents).toBe(49900);
  });
  it("charges per-meter overage above allowance", () => {
    const b = computeBill(
      { jobsProcessed: 60, aiSpendCents: 5300, aiVoiceMinutes: 600, storageBytes: 12 * GB }, band);
    // jobs: 10 over * 500 = 5000; voice: 100 over * 15 = 1500;
    // storage: ceil(2GB) * 25 = 50; ai: ceil(300c/100=3) * 150 = 450
    expect(b.overages).toEqual({ jobs: 5000, voice: 1500, storage: 50, aiSpend: 450 });
    expect(b.overageTotalCents).toBe(7000);
    expect(b.totalCents).toBe(49900 + 7000);
  });
});
