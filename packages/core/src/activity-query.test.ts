import { describe, it, expect } from "vitest";
import { parseActivityQuery } from "./activity-query";

function fromParams(params: Record<string, string>) {
  return (key: string) => params[key] ?? null;
}

describe("parseActivityQuery", () => {
  it("maps a fully-valid input through", () => {
    const result = parseActivityQuery(
      fromParams({
        limit: "50",
        before: "2026-01-01T00:00:00.000Z",
        agent: "finance",
        status: "error",
        job: "11111111-2222-3333-4444-555555555555",
      }),
    );
    expect(result.limit).toBe(50);
    expect(result.before).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(result.agent).toBe("finance");
    expect(result.status).toBe("error");
    expect(result.jobId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("defaults limit to 30 when missing", () => {
    const result = parseActivityQuery(fromParams({}));
    expect(result.limit).toBe(30);
  });

  it("omits agent when it is not a valid enum value", () => {
    const result = parseActivityQuery(fromParams({ agent: "bogus" }));
    expect(result.agent).toBeUndefined();
  });

  it("omits before when the date is unparseable", () => {
    const result = parseActivityQuery(fromParams({ before: "garbage" }));
    expect(result.before).toBeUndefined();
  });

  it("falls back to the default limit when limit is non-numeric", () => {
    const result = parseActivityQuery(fromParams({ limit: "abc" }));
    expect(result.limit).toBe(30);
  });

  it("clamps limit to the 100 max", () => {
    const result = parseActivityQuery(fromParams({ limit: "99999" }));
    expect(result.limit).toBe(100);
  });

  it("omits jobId when it is not a valid uuid", () => {
    const result = parseActivityQuery(fromParams({ job: "notauuid" }));
    expect(result.jobId).toBeUndefined();
  });

  it("omits status when it is not one of the known values", () => {
    const result = parseActivityQuery(fromParams({ status: "bogus" }));
    expect(result.status).toBeUndefined();
  });

  it("parses a valid lead uuid", () => {
    const q = parseActivityQuery((k) => (k === "lead" ? "00000000-0000-0000-0000-000000000001" : null));
    expect(q.leadId).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("drops a non-uuid lead param", () => {
    const q = parseActivityQuery((k) => (k === "lead" ? "not-a-uuid" : null));
    expect(q.leadId).toBeUndefined();
  });
});
