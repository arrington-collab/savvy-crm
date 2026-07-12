import { describe, it, expect } from "vitest";
import { matchJobByName } from "./match";

const cands = [
  { jobId: "j1", name: "John Hendricks" },
  { jobId: "j2", name: "Yates Roofing" },
  { jobId: "j3", name: null },
];

describe("matchJobByName", () => {
  it("matches on a surname token in the question", () => {
    expect(matchJobByName("did we send the Hendricks estimate?", cands)).toEqual({ jobId: "j1", name: "John Hendricks" });
  });

  it("is case-insensitive", () => {
    expect(matchJobByName("what's left on YATES", cands)).toEqual({ jobId: "j2", name: "Yates Roofing" });
  });

  it("returns null when no customer name token appears", () => {
    expect(matchJobByName("how's the weather", cands)).toBeNull();
  });

  it("ignores short tokens and null names", () => {
    // "of" / "is" are too short to match; the null-named candidate never matches.
    expect(matchJobByName("is it done", cands)).toBeNull();
  });

  it("prefers the candidate with more token hits", () => {
    const more = [
      { jobId: "a", name: "Yates" },
      { jobId: "b", name: "Yates Roofing" },
    ];
    expect(matchJobByName("update on yates roofing please", more)).toEqual({ jobId: "b", name: "Yates Roofing" });
  });
});
