import { describe, it, expect, vi } from "vitest";
import { renderTemplate } from "./render-template";

describe("renderTemplate", () => {
  it("substitutes {{var}} (with surrounding whitespace tolerance)", () => {
    expect(renderTemplate("Hi {{name}}, see {{ link }}", { name: "Jane", link: "x" }))
      .toBe("Hi Jane, see x");
  });
  it("renders unknown vars as empty string and does not throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(renderTemplate("Hi {{missing}}!", { name: "Jane" })).toBe("Hi !");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("leaves text without placeholders unchanged", () => {
    expect(renderTemplate("plain body", {})).toBe("plain body");
  });
});
