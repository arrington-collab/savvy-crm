import { describe, it, expect } from "vitest";
import { rollupPersonaActivity } from "./agent-roster";

const at = (iso: string) => new Date(iso);

describe("rollupPersonaActivity", () => {
  it("counts actions, errors and skips per persona key", () => {
    const r = rollupPersonaActivity([
      { personaKey: "NOVA", status: "ok", startedAt: at("2026-07-04T09:00:00Z") },
      { personaKey: "NOVA", status: "ok", startedAt: at("2026-07-04T10:00:00Z") },
      { personaKey: "NOVA", status: "error", startedAt: at("2026-07-04T11:00:00Z") },
      { personaKey: "VERA", status: "skipped", startedAt: at("2026-07-04T08:00:00Z") },
    ]);
    expect(r.NOVA).toEqual({ actions: 3, ok: 2, errors: 1, skips: 0, lastRunAt: at("2026-07-04T11:00:00Z") });
    expect(r.VERA).toEqual({ actions: 1, ok: 0, errors: 0, skips: 1, lastRunAt: at("2026-07-04T08:00:00Z") });
  });

  it("tracks the most recent run per persona regardless of input order", () => {
    const r = rollupPersonaActivity([
      { personaKey: "MILO", status: "ok", startedAt: at("2026-07-04T06:00:00Z") },
      { personaKey: "MILO", status: "ok", startedAt: at("2026-07-04T12:00:00Z") },
      { personaKey: "MILO", status: "ok", startedAt: at("2026-07-04T09:00:00Z") },
    ]);
    expect(r.MILO!.lastRunAt).toEqual(at("2026-07-04T12:00:00Z"));
  });

  it("returns no entry for a persona with no runs", () => {
    const r = rollupPersonaActivity([{ personaKey: "SCOUT", status: "ok", startedAt: at("2026-07-04T09:00:00Z") }]);
    expect(r.RAINE).toBeUndefined();
  });

  it("handles an empty window", () => {
    expect(rollupPersonaActivity([])).toEqual({});
  });
});
