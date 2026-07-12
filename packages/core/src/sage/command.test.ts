import { describe, it, expect } from "vitest";
import { parseSageCommand } from "./command";

describe("parseSageCommand", () => {
  it("parses a bare number as an action", () => {
    expect(parseSageCommand("1")).toEqual({ type: "action", n: 1 });
  });

  it("trims whitespace and parses multi-digit actions", () => {
    expect(parseSageCommand("  12 ")).toEqual({ type: "action", n: 12 });
  });

  it("parses a number with a trailing ? as a detail request", () => {
    expect(parseSageCommand("1?")).toEqual({ type: "detail", n: 1 });
  });

  it("parses YES/Y (any case) as a positive confirm", () => {
    expect(parseSageCommand("YES")).toEqual({ type: "confirm", ok: true });
    expect(parseSageCommand("y")).toEqual({ type: "confirm", ok: true });
  });

  it("parses NO/N (any case) as a negative confirm", () => {
    expect(parseSageCommand("NO")).toEqual({ type: "confirm", ok: false });
    expect(parseSageCommand("n")).toEqual({ type: "confirm", ok: false });
  });

  it("parses HELP / SAGE / QUEUE as help", () => {
    expect(parseSageCommand("HELP")).toEqual({ type: "help" });
    expect(parseSageCommand("sage")).toEqual({ type: "help" });
    expect(parseSageCommand("Queue")).toEqual({ type: "help" });
  });

  it("parses VERIFY <code> as a verify command", () => {
    expect(parseSageCommand("VERIFY 123456")).toEqual({ type: "verify", code: "123456" });
  });

  it("parses a bare 6-digit code as a verify command", () => {
    expect(parseSageCommand("123456")).toEqual({ type: "verify", code: "123456" });
  });

  it("falls back to freetext for a question", () => {
    expect(parseSageCommand("did we send the Hendricks estimate?")).toEqual({
      type: "freetext",
      text: "did we send the Hendricks estimate?",
    });
  });

  it("treats zero and negative numbers as freetext, not actions", () => {
    expect(parseSageCommand("0")).toEqual({ type: "freetext", text: "0" });
  });
});
