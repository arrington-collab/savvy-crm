import { describe, it, expect } from "vitest";
import { randomShortCode } from "./short-code";

describe("randomShortCode", () => {
  it("returns 8 characters", () => {
    expect(randomShortCode()).toHaveLength(8);
  });

  it("only contains base62 characters", () => {
    const code = randomShortCode();
    expect(code).toMatch(/^[0-9A-Za-z]{8}$/);
  });

  it("is deterministic with provided bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(randomShortCode(bytes)).toBe(randomShortCode(bytes));
  });

  it("produces different codes for different byte inputs", () => {
    const a = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
    const b = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(randomShortCode(a)).not.toBe(randomShortCode(b));
  });

  it("maps byte 0 to '0' and produces consistent output", () => {
    const bytes = new Uint8Array(8).fill(0);
    expect(randomShortCode(bytes)).toBe("00000000");
  });
});
