import { describe, it, expect } from "vitest";
import { SHOWCASE } from "./showcase-config";

describe("SHOWCASE config", () => {
  it("exposes the program thresholds", () => {
    expect(SHOWCASE.RUN_STALE_MINUTES).toBe(10);
    expect(SHOWCASE.POLL_SECONDS).toBe(15);
    expect(SHOWCASE.SPINNER_MAX_SECONDS).toBe(90);
    expect(SHOWCASE.COLD_DAYS).toBe(7);
    expect(SHOWCASE.REPLAY_SECONDS).toBe(90);
  });
});
