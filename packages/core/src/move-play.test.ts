import { describe, it, expect } from "vitest";
import {
  parseMovePlayConfig, moveConfidence, moveVerdict, DEFAULT_MOVE_PLAY_COPY,
} from "./move-play";

describe("parseMovePlayConfig", () => {
  it("defaults: enabled, threshold 80, no transfer fee, rubric-safe copy", () => {
    const cfg = parseMovePlayConfig(undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.confidenceThreshold).toBe(80);
    expect(cfg.transferFeeCents).toBe(0);
    expect(cfg.copy.playA.length).toBeGreaterThan(0);
    expect(cfg.copy.playB.length).toBeGreaterThan(0);
    expect(cfg.terms.length).toBeGreaterThan(0);
  });

  it("accepts tenant overrides", () => {
    const cfg = parseMovePlayConfig({ confidenceThreshold: 95, transferFeeCents: 9900 });
    expect(cfg.confidenceThreshold).toBe(95);
    expect(cfg.transferFeeCents).toBe(9900);
  });

  it("default copy follows the rubric — no discounts, no pressure", () => {
    for (const body of Object.values(DEFAULT_MOVE_PLAY_COPY)) {
      const lower = body.toLowerCase();
      expect(lower).not.toContain("discount");
      expect(lower).not.toContain("limited time");
      expect(lower).not.toMatch(/act now|last chance|urgent/);
    }
  });
});

describe("moveConfidence — never act on a single soft signal", () => {
  it("scores ncoa 60, returned_mail 25, manual 100; sums capped at 100", () => {
    expect(moveConfidence([{ kind: "ncoa" }])).toBe(60);
    expect(moveConfidence([{ kind: "returned_mail" }])).toBe(25);
    expect(moveConfidence([{ kind: "manual" }])).toBe(100);
    expect(moveConfidence([{ kind: "ncoa" }, { kind: "returned_mail" }])).toBe(85);
    expect(moveConfidence([{ kind: "manual" }, { kind: "ncoa" }])).toBe(100); // capped
    expect(moveConfidence([])).toBe(0);
  });
});

describe("moveVerdict", () => {
  it("a single soft signal only raises a verification card; threshold confirms", () => {
    expect(moveVerdict(60, 80)).toBe("verify");   // NCOA alone
    expect(moveVerdict(25, 80)).toBe("verify");   // returned mail alone
    expect(moveVerdict(85, 80)).toBe("confirm");  // NCOA + returned mail
    expect(moveVerdict(100, 80)).toBe("confirm"); // manual always confirms
    expect(moveVerdict(0, 80)).toBe("verify");
  });
});
