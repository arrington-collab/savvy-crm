import { describe, it, expect } from "vitest";
import { evaluatePhaseEvidence, phaseProgress, DEFAULT_PHASE_TEMPLATES, type PhaseTemplateItem } from "./production-phase";

const TEAR_OFF: PhaseTemplateItem = {
  key: "tear_off", label: "Tear-off", sortOrder: 1, customerVisible: true,
  expectedDurationHours: 4,
  evidence: { minPhotos: 3, requiredShots: ["deck"] },
};

describe("evaluatePhaseEvidence — the checklist IS the completion definition", () => {
  it("incomplete while photo count or required shots are missing", () => {
    expect(evaluatePhaseEvidence(TEAR_OFF, [{ shot: "deck" }, { shot: null }]).complete).toBe(false); // 2 < 3
    expect(evaluatePhaseEvidence(TEAR_OFF, [{ shot: null }, { shot: null }, { shot: null }]).complete).toBe(false); // no deck shot
  });

  it("complete when count AND required shots are satisfied; reports what is missing until then", () => {
    const partial = evaluatePhaseEvidence(TEAR_OFF, [{ shot: null }, { shot: null }]);
    expect(partial.missing).toEqual({ photos: 1, shots: ["deck"] });

    const done = evaluatePhaseEvidence(TEAR_OFF, [{ shot: "deck" }, { shot: null }, { shot: null }]);
    expect(done.complete).toBe(true);
    expect(done.missing).toEqual({ photos: 0, shots: [] });
  });
});

describe("phaseProgress — the job-card line", () => {
  it("counts done phases and flags pace against expected duration", () => {
    const phases = [
      { key: "staged_materials", status: "done", startedAt: null, expectedDurationHours: 1 },
      { key: "tear_off", status: "in_progress", startedAt: new Date(Date.now() - 2 * 3600_000), expectedDurationHours: 4 },
      { key: "install", status: "pending", startedAt: null, expectedDurationHours: 8 },
    ];
    const p = phaseProgress(phases, new Date());
    expect(p.done).toBe(1);
    expect(p.total).toBe(3);
    expect(p.current?.key).toBe("tear_off");
    expect(p.current?.onPace).toBe(true); // 2h elapsed of 4h expected

    const lagging = phaseProgress([
      { key: "tear_off", status: "in_progress", startedAt: new Date(Date.now() - 7 * 3600_000), expectedDurationHours: 4 },
    ], new Date());
    expect(lagging.current?.onPace).toBe(false); // 7h > 4h × 1.5 default threshold
  });
});

describe("DEFAULT_PHASE_TEMPLATES — v1 Library seed content", () => {
  it("covers retail/insurance/repair with ordered phases and evidence definitions", () => {
    for (const jobType of ["retail", "insurance", "repair"] as const) {
      const t = DEFAULT_PHASE_TEMPLATES[jobType];
      expect(t.length).toBeGreaterThan(2);
      expect(t.every((p) => p.key && p.evidence.minPhotos >= 1)).toBe(true);
      // sort orders strictly increase
      expect(t.map((p) => p.sortOrder)).toEqual([...t.map((p) => p.sortOrder)].sort((a, b) => a - b));
    }
    // cleanup requires the magnet-sweep shot on full replacements (owner spec)
    const cleanup = DEFAULT_PHASE_TEMPLATES.retail.find((p) => p.key === "cleanup")!;
    expect(cleanup.evidence.requiredShots).toContain("magnet_sweep");
  });
});
