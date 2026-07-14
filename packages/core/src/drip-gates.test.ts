import { describe, it, expect } from "vitest";
import { dripGateOpen } from "./drip-gates";

describe("dripGateOpen", () => {
  it("no gate = always open", () => {
    expect(dripGateOpen(undefined, { financingLive: false, features: new Set() })).toBe(true);
  });
  it("financing_live follows the seam", () => {
    expect(dripGateOpen("financing_live", { financingLive: false, features: new Set() })).toBe(false);
    expect(dripGateOpen("financing_live", { financingLive: true, features: new Set() })).toBe(true);
  });
  it("feature gates activate the day the feature ships — no code change", () => {
    expect(dripGateOpen("feature:color_render", { financingLive: false, features: new Set() })).toBe(false);
    expect(dripGateOpen("feature:color_render", { financingLive: false, features: new Set(["color_render"]) })).toBe(true);
  });
});
