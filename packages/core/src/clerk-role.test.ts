import { describe, it, expect } from "vitest";
import { mapClerkRole } from "./clerk-role.js";

describe("mapClerkRole", () => {
  it("creator → owner regardless of org role", () => {
    expect(mapClerkRole("org:admin", true)).toBe("owner");
    expect(mapClerkRole("org:member", true)).toBe("owner");
  });
  it("org:admin → admin, anything else → rep", () => {
    expect(mapClerkRole("org:admin", false)).toBe("admin");
    expect(mapClerkRole("org:member", false)).toBe("rep");
    expect(mapClerkRole(null, false)).toBe("rep");
    expect(mapClerkRole(undefined, false)).toBe("rep");
  });
});
