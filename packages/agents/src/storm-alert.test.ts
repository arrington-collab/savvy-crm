import { describe, expect, it } from "vitest";
import { clusterKnockCenters, newAlertSwaths, swathSignature, alertEmailHtml, MAX_CENTERS } from "./storm-alert";
import type { StormSwath } from "@savvy/integrations";

const swath = (over: Partial<StormSwath> = {}): StormSwath => ({
  kind: "wind",
  rings: [[[33.4, -111.9], [33.5, -111.9], [33.5, -111.8]]],
  size: null,
  windMph: 65,
  date: "2026-07-10T18:00:00Z",
  ...over,
});

describe("clusterKnockCenters", () => {
  it("returns densest-area centroids, capped", () => {
    const mesa = Array.from({ length: 20 }, (_, i) => ({ lat: 33.42 + i * 0.001, lng: -111.88 }));
    const vegas = Array.from({ length: 5 }, () => ({ lat: 36.15, lng: -115.3 }));
    const denver = [{ lat: 39.7, lng: -105.0 }];
    const centers = clusterKnockCenters([...mesa, ...vegas, ...denver]);
    expect(centers.length).toBeLessThanOrEqual(MAX_CENTERS);
    expect(centers[0]!.lat).toBeCloseTo(33.43, 1); // densest first
    expect(centers[1]!.lat).toBeCloseTo(36.15, 1);
  });
  it("empty in, empty out", () => {
    expect(clusterKnockCenters([])).toEqual([]);
  });
});

describe("newAlertSwaths", () => {
  const NOW = new Date("2026-07-11T14:00:00Z");
  it("keeps only unseen events inside the 48h window, deduped", () => {
    const fresh = swath();
    const stale = swath({ date: "2026-07-01T00:00:00Z", windMph: 80 });
    const dupe = swath(); // same signature as fresh
    const out = newAlertSwaths([fresh, stale, dupe], [], NOW);
    expect(out).toHaveLength(1);
    expect(swathSignature(out[0]!)).toBe("wind:2026-07-10:65");
  });
  it("previously-seen signatures never re-alert", () => {
    expect(newAlertSwaths([swath()], ["wind:2026-07-10:65"], NOW)).toEqual([]);
  });
});

describe("alertEmailHtml", () => {
  it("names the company and lists the events", () => {
    const html = alertEmailHtml("Northwind Roofing", [{ kind: "hail", mag: '1.75" hail', date: "2026-07-10" }]);
    expect(html).toContain("Northwind Roofing");
    expect(html).toContain("⛈ Hail");
    expect(html).toContain("1.75");
  });
});
