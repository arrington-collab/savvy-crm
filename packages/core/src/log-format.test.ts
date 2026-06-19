import { describe, expect, it } from "vitest";
import { formatLog } from "./log-format.js";

describe("formatLog", () => {
  it("produces a single JSON line with level, msg and time", () => {
    const line = formatLog("info", "hello", undefined, "2026-06-18T00:00:00.000Z");
    expect(JSON.parse(line)).toEqual({
      level: "info",
      msg: "hello",
      time: "2026-06-18T00:00:00.000Z",
    });
  });

  it("merges context fields at the top level", () => {
    const line = formatLog("error", "boom", { route: "/api/leads", tenantId: "t1" }, "2026-06-18T00:00:00.000Z");
    expect(JSON.parse(line)).toEqual({
      level: "error",
      msg: "boom",
      time: "2026-06-18T00:00:00.000Z",
      route: "/api/leads",
      tenantId: "t1",
    });
  });

  it("does not let ctx override the reserved level/msg/time fields", () => {
    const line = formatLog("warn", "real", { level: "spoof", msg: "spoof", time: "spoof" } as never, "2026-06-18T00:00:00.000Z");
    expect(JSON.parse(line)).toEqual({
      level: "warn",
      msg: "real",
      time: "2026-06-18T00:00:00.000Z",
    });
  });
});
