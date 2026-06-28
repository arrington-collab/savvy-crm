import { describe, it, expect } from "vitest";
import { shouldAutoAct } from "./task-automation";

describe("shouldAutoAct", () => {
  it("only full auto-acts", () => {
    expect(shouldAutoAct("full")).toBe(true);
    expect(shouldAutoAct(" Full ")).toBe(true);
    expect(shouldAutoAct("partial")).toBe(false);
    expect(shouldAutoAct("manual")).toBe(false);
    expect(shouldAutoAct(null)).toBe(false);
    expect(shouldAutoAct(undefined)).toBe(false);
    expect(shouldAutoAct("whatever")).toBe(false);
  });
});
