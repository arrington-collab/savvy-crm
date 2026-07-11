import { describe, it, expect } from "vitest";
import { buildLeadRowHref, parseLeadsListReturn } from "./leads-list-nav";

describe("buildLeadRowHref — carry list filters onto the row link", () => {
  it("no filters → bare lead href", () => {
    expect(buildLeadRowHref("abc", {})).toBe("/leads/abc");
  });

  it("status + sort → encoded ?from so the tile can return to the same view", () => {
    expect(buildLeadRowHref("abc", { status: "won", sort: "age" })).toBe(
      "/leads/abc?from=status%3Dwon%26sort%3Dage",
    );
  });

  it("ignores an unknown status but keeps a non-default sort", () => {
    expect(buildLeadRowHref("abc", { status: "bogus", sort: "age" })).toBe(
      "/leads/abc?from=sort%3Dage",
    );
  });

  it("omits the default 'score' sort so the default view keeps a clean href", () => {
    expect(buildLeadRowHref("abc", { status: undefined, sort: "score" })).toBe("/leads/abc");
    expect(buildLeadRowHref("abc", { status: "won", sort: "score" })).toBe("/leads/abc?from=status%3Dwon");
  });
});

describe("parseLeadsListReturn — rebuild the leads-list href from ?from", () => {
  it("missing ?from → plain /leads", () => {
    expect(parseLeadsListReturn(undefined)).toBe("/leads");
    expect(parseLeadsListReturn(null)).toBe("/leads");
    expect(parseLeadsListReturn("")).toBe("/leads");
  });

  it("round-trips a valid filtered view", () => {
    expect(parseLeadsListReturn("status%3Dwon%26sort%3Dage")).toBe("/leads?status=won&sort=age");
    expect(parseLeadsListReturn("status=won&sort=age")).toBe("/leads?status=won&sort=age");
  });

  it("RED PATH: drops unknown/injected keys and invalid values", () => {
    // status not in LEAD_STATUS is dropped; junk keys ignored; XSS payload never reflected.
    expect(parseLeadsListReturn("status=%3Cscript%3E&sort=age&evil=1")).toBe("/leads?sort=age");
    expect(parseLeadsListReturn("status=deleted&sort=weird")).toBe("/leads");
  });

  it("survives a malformed (non-decodable) from value", () => {
    expect(parseLeadsListReturn("%E0%A4%A")).toBe("/leads");
  });
});
