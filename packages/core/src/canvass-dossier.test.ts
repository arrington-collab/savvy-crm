import { describe, expect, it } from "vitest";
import {
  buildCanvassDossier,
  dossierBoundingBox,
  escapeIlike,
  normalizeStreetName,
  DOSSIER_JOB_BBOX_DEG,
  DOSSIER_NEARBY_LIMIT,
  type DossierJobRow,
  type DossierKnockRow,
} from "./canvass-dossier";

// Denver-ish anchor point. ~0.00001° lat ≈ 1.11 m, so offsets below are metres-ish.
const LAT = 39.7392;
const LNG = -104.9903;
const metersNorth = (m: number) => LAT + m / 111_320;
const metersEast = (m: number) => LNG + m / (111_320 * Math.cos((LAT * Math.PI) / 180));

const jobAt = (m: number, over: Partial<DossierJobRow> = {}): DossierJobRow => ({
  customerName: "Hendricks",
  address: "1420 Elm St",
  lat: metersNorth(m),
  lng: LNG,
  stage: "closed",
  ...over,
});

const knockAt = (m: number, over: Partial<DossierKnockRow> = {}): DossierKnockRow => ({
  lat: metersNorth(m),
  lng: LNG,
  outcome: "noanswer",
  createdAt: new Date("2026-07-02T18:04:00Z"),
  repName: "Alex",
  ...over,
});

describe("dossierBoundingBox", () => {
  it("spans the requested degrees of latitude and widens longitude by cos(lat)", () => {
    const b = dossierBoundingBox(LAT, LNG, DOSSIER_JOB_BBOX_DEG);
    expect(b.maxLat - b.minLat).toBeCloseTo(2 * DOSSIER_JOB_BBOX_DEG, 10);
    expect(b.maxLng - b.minLng).toBeGreaterThan(2 * DOSSIER_JOB_BBOX_DEG);
    // A point 250 m away must survive the prefilter.
    expect(metersNorth(250)).toBeLessThan(b.maxLat);
    expect(metersEast(250)).toBeLessThan(b.maxLng);
  });
});

describe("normalizeStreetName", () => {
  it("lowercases, strips the house number, and drops city/state", () => {
    expect(normalizeStreetName("1428 E Main St, Mesa, AZ 85201")).toBe("e main st");
    expect(normalizeStreetName("12 Elm St")).toBe("elm st");
    expect(normalizeStreetName("1420-B Elm St")).toBe("elm st");
  });
  it("returns null when nothing street-like remains", () => {
    expect(normalizeStreetName("")).toBeNull();
    expect(normalizeStreetName(null)).toBeNull();
    expect(normalizeStreetName("1428")).toBeNull();
    expect(normalizeStreetName("   ")).toBeNull();
  });
});

describe("escapeIlike", () => {
  it("escapes ILIKE metacharacters", () => {
    expect(escapeIlike("50% st_\\x")).toBe("50\\% st\\_\\\\x");
    expect(escapeIlike("elm st")).toBe("elm st");
  });
});

describe("buildCanvassDossier", () => {
  const base = { lat: LAT, lng: LNG, streetAddresses: [] as string[], knockRows: [] as DossierKnockRow[] };

  it("keeps nearby jobs within 250 m, nearest first, with computed distances", () => {
    const d = buildCanvassDossier({
      ...base,
      jobRows: [
        jobAt(300, { customerName: "TooFar" }),
        jobAt(38),
        jobAt(120, { customerName: "Ortega", address: "1490 Elm St" }),
        { customerName: "NoCoords", address: "9 Elm St", lat: null, lng: null, stage: "closed" },
      ],
    });
    expect(d.nearby.map((n) => n.customerName)).toEqual(["Hendricks", "Ortega"]);
    expect(d.nearby[0]!.distanceM).toBeGreaterThan(30);
    expect(d.nearby[0]!.distanceM).toBeLessThan(46);
    expect(d.nearby[0]!.stage).toBe("closed");
  });

  it("dedupes multiple jobs at the same household and caps the list", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      jobAt(40 + i * 10, { customerName: `C${i}`, address: `${i} Elm St` }),
    );
    const d = buildCanvassDossier({ ...base, jobRows: [...rows, jobAt(45, { customerName: "C0", address: "0 Elm St" })] });
    expect(d.nearby).toHaveLength(DOSSIER_NEARBY_LIMIT);
    expect(d.nearby.filter((n) => n.customerName === "C0")).toHaveLength(1);
  });

  it("counts roofs on the street by exact normalized street match", () => {
    const d = buildCanvassDossier({
      ...base,
      address: "1428 Elm St",
      jobRows: [],
      streetAddresses: ["12 Elm St, Denver, CO", "99 ELM ST", "4 Helm St", "77 Elmwood Ave"],
    });
    expect(d.roofsOnStreet).toBe(2);
  });

  it("falls back to the nearby-household count when no address is given", () => {
    const d = buildCanvassDossier({
      ...base,
      jobRows: [jobAt(38), jobAt(40), jobAt(120, { customerName: "Ortega", address: "1490 Elm St" }), jobAt(400, { customerName: "Far" })],
    });
    expect(d.roofsOnStreet).toBe(2); // Hendricks (deduped) + Ortega; 400 m is out
  });

  it("returns the most recent prior knock within ~30 m, or null", () => {
    const older = knockAt(5, { outcome: "callback", createdAt: new Date("2026-06-01T00:00:00Z"), repName: "Sam" });
    const newer = knockAt(10);
    const far = knockAt(60, { outcome: "sale", createdAt: new Date("2026-07-10T00:00:00Z") });
    const d = buildCanvassDossier({ ...base, jobRows: [], knockRows: [older, far, newer] });
    expect(d.priorKnock).toEqual({ outcome: "noanswer", ts: "2026-07-02T18:04:00.000Z", repName: "Alex" });

    const none = buildCanvassDossier({ ...base, jobRows: [], knockRows: [far] });
    expect(none.priorKnock).toBeNull();
  });

  it("flags an existing customer only when a job is within ~30 m", () => {
    expect(buildCanvassDossier({ ...base, jobRows: [jobAt(12)] }).isExistingCustomer).toBe(true);
    expect(buildCanvassDossier({ ...base, jobRows: [jobAt(38)] }).isExistingCustomer).toBe(false);
  });

  it("returns an empty dossier from empty rows", () => {
    expect(buildCanvassDossier({ ...base, jobRows: [] })).toEqual({
      roofsOnStreet: 0,
      nearby: [],
      priorKnock: null,
      isExistingCustomer: false,
    });
  });
});
