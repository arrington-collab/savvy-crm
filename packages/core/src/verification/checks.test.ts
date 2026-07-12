import { describe, it, expect } from "vitest";
import { getCheck } from "./checks";
import type { EvidenceCtx, VerificationDb } from "./types";

function fakeDb(rows: Record<string, unknown>[]): VerificationDb {
  return {
    async query() {
      return { rows: rows as never[] };
    },
  };
}

const ctx = (rows: Record<string, unknown>[]): EvidenceCtx => ({
  tenantId: "t1",
  db: fakeDb(rows),
  params: {},
  window: { start: new Date("2026-07-01T00:00:00Z"), end: new Date("2026-07-02T00:00:00Z") },
});

describe("finance.price_guard", () => {
  it("is registered", () => {
    expect(getCheck("finance.price_guard")).toBeDefined();
  });

  it("fails and returns a supplier_invoice ref when a violation row is returned", async () => {
    const check = getCheck("finance.price_guard")!;
    const result = await check(ctx([{ id: "si1" }]));
    expect(result.status).toBe("fail");
    expect(result.refs).toEqual([{ type: "supplier_invoice", ref: "si1" }]);
  });

  it("passes when no violation rows are returned", async () => {
    const check = getCheck("finance.price_guard")!;
    const result = await check(ctx([]));
    expect(result.status).toBe("pass");
    expect(result.refs).toEqual([]);
  });
});

describe("activity.attribution", () => {
  it("is registered", () => {
    expect(getCheck("activity.attribution")).toBeDefined();
  });

  it("fails and returns an agent_run ref when an unattributed run is returned", async () => {
    const check = getCheck("activity.attribution")!;
    const result = await check(ctx([{ id: "run-1" }]));
    expect(result.status).toBe("fail");
    expect(result.refs).toEqual([{ type: "agent_run", ref: "run-1" }]);
  });

  it("passes when no violation rows are returned", async () => {
    const check = getCheck("activity.attribution")!;
    const result = await check(ctx([]));
    expect(result.status).toBe("pass");
    expect(result.refs).toEqual([]);
  });
});

describe("sage.remote_actions", () => {
  it("is registered", () => {
    expect(getCheck("sage.remote_actions")).toBeDefined();
  });

  it("fails and returns a sage_remote_action ref for an un-rejected action from an unverified number", async () => {
    const check = getCheck("sage.remote_actions")!;
    const result = await check(ctx([{ id: "sra1" }]));
    expect(result.status).toBe("fail");
    expect(result.refs).toEqual([{ type: "sage_remote_action", ref: "sra1" }]);
  });

  it("passes when no unverified actions slipped through", async () => {
    const check = getCheck("sage.remote_actions")!;
    const result = await check(ctx([]));
    expect(result.status).toBe("pass");
    expect(result.refs).toEqual([]);
  });
});
