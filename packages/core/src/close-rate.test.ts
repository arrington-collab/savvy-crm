import { describe, it, expect } from "vitest";
import { closeRateReport } from "./close-rate";

const row = (over: Partial<Parameters<typeof closeRateReport>[0][number]>) => ({
  templateVersion: "retail-v1",
  tier: null as string | null,
  opened: false,
  accepted: false,
  videoPersonalized: null as boolean | null,
  ...over,
});

describe("closeRateReport", () => {
  it("activates a version only at n>=20 — below that it reports insufficient data honestly", () => {
    const rows = Array.from({ length: 5 }, () => row({ accepted: true, opened: true }));
    const r = closeRateReport(rows);
    expect(r.versions[0]).toMatchObject({ version: "retail-v1", n: 5, active: false });
    expect(r.versions[0]!.closeRateBps).toBeNull(); // no rates from insufficient data
  });

  it("computes open + close rates per version once active", () => {
    const rows = [
      ...Array.from({ length: 15 }, () => row({ opened: true, accepted: true })),
      ...Array.from({ length: 10 }, () => row({ opened: true })),
      ...Array.from({ length: 5 }, () => row({})),
    ];
    const r = closeRateReport(rows);
    const v = r.versions[0]!;
    expect(v).toMatchObject({ n: 30, active: true });
    expect(v.openRateBps).toBe(Math.round((25 / 30) * 10_000));
    expect(v.closeRateBps).toBe(5000); // 15/30
  });

  it("splits by tier and by video personalized-vs-generic (the 10% hypothesis)", () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row({ tier: "better", accepted: true, videoPersonalized: true })),
      ...Array.from({ length: 20 }, () => row({ tier: "good", videoPersonalized: false })),
      ...Array.from({ length: 4 }, () => row({ tier: "good", accepted: true, videoPersonalized: false })),
    ];
    const r = closeRateReport(rows);
    expect(r.tiers.find((t) => t.tier === "better")).toMatchObject({ n: 20, closeRateBps: 10_000 });
    expect(r.tiers.find((t) => t.tier === "good")!.closeRateBps).toBe(Math.round((4 / 24) * 10_000));
    expect(r.video.personalized).toMatchObject({ n: 20, closeRateBps: 10_000 });
    expect(r.video.generic!.closeRateBps).toBe(Math.round((4 / 24) * 10_000));
  });
});
