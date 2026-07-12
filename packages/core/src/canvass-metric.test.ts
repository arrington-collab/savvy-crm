import { describe, expect, it } from "vitest";
import { metricValue } from "./canvass-metric";

const knocks = [
  { outcome: "noanswer" },
  { outcome: "notint" },
  { outcome: "appt" },
  { outcome: "sale", amount: 8000 },
  { outcome: "sale", amount: 2000 },
];

describe("metricValue", () => {
  it("computes each metric from a knock set", () => {
    expect(metricValue(knocks, "doors")).toBe(5);
    expect(metricValue(knocks, "contacts")).toBe(4); // all except the noanswer
    expect(metricValue(knocks, "appts")).toBe(1);
    expect(metricValue(knocks, "sales")).toBe(2);
    expect(metricValue(knocks, "revenue")).toBe(10000);
    // points: door1*5 + contact2*4 + appt10 + sale(25+8)+ sale(25+2) = 5+8+10+33+27 = 83
    expect(metricValue(knocks, "points")).toBe(83);
  });
  it("is 0 for an empty set", () => {
    expect(metricValue([], "points")).toBe(0);
    expect(metricValue([], "revenue")).toBe(0);
  });
});
