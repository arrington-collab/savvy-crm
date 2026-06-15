import { describe, it, expect } from "vitest";
import { missingRequiredPhotos, parseProductionConfig } from "./production";

describe("missingRequiredPhotos", () => {
  it("returns required labels with no matching present (case-insensitive, trimmed)", () => {
    expect(missingRequiredPhotos(["before", "after"], ["Before"])).toEqual(["after"]);
    expect(missingRequiredPhotos(["before", "after"], [" before ", "AFTER"])).toEqual([]);
    expect(missingRequiredPhotos([], ["x"])).toEqual([]);
  });
});

describe("parseProductionConfig", () => {
  it("fills per-job-type defaults", () => {
    const cfg = parseProductionConfig(undefined);
    expect(cfg.requiredPhotos.retail).toEqual(["before", "after"]);
    expect(cfg.requiredPhotos.insurance).toEqual(["before", "after", "permit"]);
  });
  it("merges a partial override and normalizes labels", () => {
    const cfg = parseProductionConfig({ requiredPhotos: { retail: [" Before ", "DUMP"] } });
    expect(cfg.requiredPhotos.retail).toEqual(["before", "dump"]);
    expect(cfg.requiredPhotos.repair).toEqual(["before", "after"]); // default preserved
  });
});
