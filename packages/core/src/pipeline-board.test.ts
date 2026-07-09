import { describe, it, expect } from "vitest";
import {
  PIPELINE_COLUMNS,
  jobStageToColumn,
  deriveWaitingOn,
  cardMatchesFilter,
  OVER_25K_CENTS,
} from "./pipeline-board";

describe("jobStageToColumn", () => {
  it("maps the five shared lifecycle stages one-to-one", () => {
    expect(jobStageToColumn("lead")).toBe("lead");
    expect(jobStageToColumn("inspected")).toBe("inspected");
    expect(jobStageToColumn("estimate")).toBe("estimate");
    expect(jobStageToColumn("approved")).toBe("approved");
    expect(jobStageToColumn("production")).toBe("production");
  });

  it("folds closeout into production (mockup has no closeout column)", () => {
    expect(jobStageToColumn("closeout")).toBe("production");
  });

  it("maps billing to invoiced and complete to paid", () => {
    expect(jobStageToColumn("billing")).toBe("invoiced");
    expect(jobStageToColumn("complete")).toBe("paid");
  });

  it("hides lost jobs from the board (returns null)", () => {
    expect(jobStageToColumn("lost")).toBeNull();
  });

  it("covers every pipeline column with a stage", () => {
    const mapped = new Set(
      (["lead", "inspected", "estimate", "approved", "production", "closeout", "billing", "complete"] as const).map(
        jobStageToColumn,
      ),
    );
    for (const col of PIPELINE_COLUMNS) expect(mapped.has(col)).toBe(true);
  });
});

describe("deriveWaitingOn", () => {
  it("uses the next pending task's title + owner when one exists", () => {
    const w = deriveWaitingOn({
      nextTask: { title: "Roof type", automationLevel: "manual", ownerAgent: "scheduling" },
      column: "inspected",
    });
    expect(w.label).toBe("Roof type");
    expect(w.ownerAgent).toBe("scheduling");
    expect(w.isHuman).toBe(true); // manual → a person owes it
  });

  it("treats a full-auto next task as owned by an agent, not a human", () => {
    const w = deriveWaitingOn({
      nextTask: { title: "Enrich roof age", automationLevel: "full", ownerAgent: "orchestrator" },
      column: "lead",
    });
    expect(w.isHuman).toBe(false);
    expect(w.ownerAgent).toBe("orchestrator");
  });

  it("falls back to a stage-derived action with no named owner when no task is instantiated", () => {
    const w = deriveWaitingOn({ nextTask: null, column: "estimate" });
    expect(w.label).toBe("customer decision");
    expect(w.ownerAgent).toBeNull();
    expect(w.isHuman).toBe(false);
  });

  it("has a fallback action for every column", () => {
    for (const col of PIPELINE_COLUMNS) {
      const w = deriveWaitingOn({ nextTask: null, column: col });
      expect(w.label.length).toBeGreaterThan(0);
    }
  });
});

describe("cardMatchesFilter", () => {
  const base = { isStuck: false, isClaim: false, valueCents: 100000, waitingOnHuman: false };

  it("passes everything for 'all'", () => {
    expect(cardMatchesFilter(base, "all")).toBe(true);
  });

  it("'stuck' keeps only stuck/late cards", () => {
    expect(cardMatchesFilter({ ...base, isStuck: true }, "stuck")).toBe(true);
    expect(cardMatchesFilter(base, "stuck")).toBe(false);
  });

  it("'waiting_human' keeps only cards a person owes", () => {
    expect(cardMatchesFilter({ ...base, waitingOnHuman: true }, "waiting_human")).toBe(true);
    expect(cardMatchesFilter(base, "waiting_human")).toBe(false);
  });

  it("'claims' keeps only insurance jobs", () => {
    expect(cardMatchesFilter({ ...base, isClaim: true }, "claims")).toBe(true);
    expect(cardMatchesFilter(base, "claims")).toBe(false);
  });

  it("'over_25k' keeps only cards at or above the $25k line", () => {
    expect(cardMatchesFilter({ ...base, valueCents: OVER_25K_CENTS }, "over_25k")).toBe(true);
    expect(cardMatchesFilter({ ...base, valueCents: OVER_25K_CENTS - 1 }, "over_25k")).toBe(false);
    expect(cardMatchesFilter({ ...base, valueCents: null }, "over_25k")).toBe(false);
  });
});

describe("deriveWaitingOn evidence-derived missing gate", () => {
  it("names the next stage's missing evidence when there is no pending task", () => {
    const w = deriveWaitingOn({ nextTask: null, column: "lead", missingEvidence: "inspection" });
    expect(w.label).toBe("needs inspection");
    expect(w.isHuman).toBe(true);
  });
  it("falls back to the column label when nothing is missing", () => {
    const w = deriveWaitingOn({ nextTask: null, column: "lead", missingEvidence: null });
    expect(w.label).toBe("enrich & qualify");
  });
  it("a pending task still wins over missing-evidence", () => {
    const w = deriveWaitingOn({ nextTask: { title: "call HO", automationLevel: "manual", ownerAgent: "comms" }, column: "lead", missingEvidence: "inspection" });
    expect(w.label).toBe("call HO");
  });
});
