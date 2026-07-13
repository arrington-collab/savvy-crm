import { describe, it, expect } from "vitest";
import { parseBallparkConfig } from "./config";

describe("parseBallparkConfig", () => {
  it("defaults to OFF, retail-only, with sane spread/margin", () => {
    expect(parseBallparkConfig(undefined)).toEqual({
      enabled: false,
      retailOnly: true,
      betterMultiplierBps: 12500,
      spreadBps: 1000,
      marginFloorBps: 2000,
      confidenceFloor: "assessor",
    });
  });

  it("accepts overrides", () => {
    const cfg = parseBallparkConfig({ enabled: true, retailOnly: false, spreadBps: 1500, confidenceFloor: "measured" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.retailOnly).toBe(false);
    expect(cfg.spreadBps).toBe(1500);
    expect(cfg.confidenceFloor).toBe("measured");
  });
});
