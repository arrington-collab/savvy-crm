import { describe, it, expect } from "vitest";
import { strikeListOrder } from "./strike-list";

type T = { customerId: string | null; tag: string };

describe("strikeListOrder", () => {
  it("puts active members ahead of non-members (top Strike List tier)", () => {
    const members = new Set(["m1"]);
    const targets: T[] = [
      { customerId: "n1", tag: "nonmember" },
      { customerId: "m1", tag: "member" },
    ];
    const ordered = strikeListOrder(targets, members);
    expect(ordered.map((t) => t.tag)).toEqual(["member", "nonmember"]);
  });

  it("preserves original relative order within each tier", () => {
    const members = new Set(["m1", "m2"]);
    const targets: T[] = [
      { customerId: "n1", tag: "n1" },
      { customerId: "m2", tag: "m2" },
      { customerId: "n2", tag: "n2" },
      { customerId: "m1", tag: "m1" },
    ];
    // members keep m2-before-m1; non-members keep n1-before-n2
    expect(strikeListOrder(targets, members).map((t) => t.tag)).toEqual(["m2", "m1", "n1", "n2"]);
  });

  it("leaves a non-member-only batch unchanged (ordering unchanged)", () => {
    const targets: T[] = [
      { customerId: "n1", tag: "n1" },
      { customerId: "n2", tag: "n2" },
      { customerId: "n3", tag: "n3" },
    ];
    expect(strikeListOrder(targets, new Set())).toEqual(targets);
  });

  it("treats a null customerId as a non-member", () => {
    const members = new Set(["m1"]);
    const targets: T[] = [
      { customerId: null, tag: "unknown" },
      { customerId: "m1", tag: "member" },
    ];
    expect(strikeListOrder(targets, members).map((t) => t.tag)).toEqual(["member", "unknown"]);
  });
});
