import { describe, it, expect } from "vitest";
import { executed, invariant, reconciled, sampledAudit } from "./builders";
import type { EvidenceCtx, VerificationDb } from "./types";

// A fake db that returns a fixed row set and records the last query it saw.
function fakeDb(rows: Record<string, unknown>[]): VerificationDb & { last?: { text: string; params?: unknown[] } } {
  const db: VerificationDb & { last?: { text: string; params?: unknown[] } } = {
    async query(text, params) {
      db.last = { text, params };
      return { rows: rows as never[] };
    },
  };
  return db;
}

const ctx = (db: VerificationDb): EvidenceCtx => ({
  tenantId: "t1",
  db,
  params: {},
  window: { start: new Date("2026-07-01T00:00:00Z"), end: new Date("2026-07-02T00:00:00Z") },
});

describe("executed", () => {
  it("passes when an agent_run exists in the window", async () => {
    const r = await executed("ops.health_sweep")(ctx(fakeDb([{ id: "run1" }])));
    expect(r.status).toBe("pass");
    expect(r.refs).toEqual([{ type: "agent_run", ref: "run1" }]);
  });

  it("fails when no run is found", async () => {
    const db = fakeDb([]);
    const r = await executed("ops.health_sweep")(ctx(db));
    expect(r.status).toBe("fail");
    expect(db.last?.params).toEqual(["t1", "ops.health_sweep", ctx(db).window.start, ctx(db).window.end]);
  });
});

describe("invariant", () => {
  it("passes on zero violation rows", async () => {
    const r = await invariant("x", "select 1")(ctx(fakeDb([])));
    expect(r.status).toBe("pass");
    expect(r.refs).toEqual([]);
  });

  it("fails and cites refs when violations exist", async () => {
    const r = await invariant("x", "select id", { toRef: (row) => ({ type: "lead", ref: String(row.id) }) })(
      ctx(fakeDb([{ id: "a" }, { id: "b" }])),
    );
    expect(r.status).toBe("fail");
    expect(r.details).toContain("2 violation");
    expect(r.refs).toEqual([{ type: "lead", ref: "a" }, { type: "lead", ref: "b" }]);
  });

  it("defaults bind params to [tenantId] and honors a custom params builder", async () => {
    const d1 = fakeDb([]);
    await invariant("x", "select 1")(ctx(d1));
    expect(d1.last?.params).toEqual(["t1"]);

    const d2 = fakeDb([]);
    await invariant("x", "select 1", { params: (c) => [c.tenantId, c.window.start, c.window.end] })(ctx(d2));
    expect(d2.last?.params).toEqual(["t1", ctx(d2).window.start, ctx(d2).window.end]);
  });
});

describe("reconciled", () => {
  it("is stale (not fail) when the vendor fetch throws", async () => {
    const r = await reconciled(
      async () => { throw new Error("QBO 503"); },
      () => ({ status: "pass" as const, details: "", refs: [] }),
    )(ctx(fakeDb([])));
    expect(r.status).toBe("stale");
    expect(r.details).toContain("QBO 503");
  });

  it("delegates to compare when the fetch succeeds", async () => {
    const r = await reconciled(
      async () => ({ ar: 100 }),
      (ext) => ({ status: ext.ar === 100 ? ("pass" as const) : ("fail" as const), details: "", refs: [] }),
    )(ctx(fakeDb([])));
    expect(r.status).toBe("pass");
  });
});

describe("sampledAudit", () => {
  const sample = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, subject: i }));

  it("skips when there is nothing to sample", async () => {
    const r = await sampledAudit(async () => [], async () => ({ agree: true }))(ctx(fakeDb([])));
    expect(r.status).toBe("skip");
  });

  it("passes when all judgements agree", async () => {
    const r = await sampledAudit(async () => sample(4), async () => ({ agree: true }))(ctx(fakeDb([])));
    expect(r.status).toBe("pass");
  });

  it("fails when disagreement exceeds the threshold", async () => {
    const r = await sampledAudit(
      async () => sample(4),
      async (s) => ({ agree: s.id !== "s0", note: "mispriced" }), // 1/4 disagree, default max 0
    )(ctx(fakeDb([])));
    expect(r.status).toBe("fail");
    expect(r.refs).toEqual([{ type: "audit", ref: "s0", url: "mispriced" }]);
  });

  it("tolerates disagreement within the configured rate", async () => {
    const r = await sampledAudit(
      async () => sample(4),
      async (s) => ({ agree: s.id !== "s0" }),
      { maxDisagreementRate: 0.5 },
    )(ctx(fakeDb([])));
    expect(r.status).toBe("pass");
  });
});
