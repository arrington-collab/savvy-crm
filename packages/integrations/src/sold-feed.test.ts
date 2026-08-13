import { describe, it, expect } from "vitest";
import { parseSoldCsv, priceBands, dedupeSoldRows, SoldFeedParseError } from "./sold-feed";

const HEADER =
  "SOLD DATE,PROPERTY TYPE,ADDRESS,CITY,STATE OR PROVINCE,ZIP OR POSTAL CODE,PRICE,BEDS,BATHS,SQUARE FEET,YEAR BUILT,MLS#,LATITUDE,LONGITUDE,URL";
const ROW =
  "May-4-2026,Single Family Residential,123 Main St,Phoenix,AZ,85001,438000,3,2.5,1800,1994,6712345,33.4484,-112.0740,https://redfin.com/x";

describe("parseSoldCsv", () => {
  it("parses a well-formed row into normalized fields", () => {
    const { rows, skipped } = parseSoldCsv(`${HEADER}\n${ROW}`);
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      address: "123 Main St",
      city: "Phoenix",
      state: "AZ",
      zip: "85001",
      price: 438000,
      beds: 3,
      baths: 2.5,
      sqft: 1800,
      yearBuilt: 1994,
      mls: "6712345",
      lat: 33.4484,
      lng: -112.074,
      soldDate: "2026-05-04",
    });
  });

  // The whole point of resolving columns by header name: Redfin reordering
  // its export must not silently shift every value one column left.
  it("survives reordered columns", () => {
    const header = "ADDRESS,MLS#,SOLD DATE,LATITUDE,LONGITUDE,PROPERTY TYPE,ZIP OR POSTAL CODE";
    const row = "123 Main St,6712345,May-4-2026,33.4484,-112.0740,Single Family Residential,85001";
    const { rows } = parseSoldCsv(`${header}\n${row}`);
    expect(rows[0]).toMatchObject({ address: "123 Main St", mls: "6712345", lat: 33.4484 });
  });

  it("handles quoted fields containing commas", () => {
    const row =
      '"May-4-2026",Single Family Residential,"123 Main St, Unit 4",Phoenix,AZ,85001,438000,3,2.5,1800,1994,6712345,33.4484,-112.0740,https://x';
    const { rows } = parseSoldCsv(`${HEADER}\n${row}`);
    expect(rows[0]!.address).toBe("123 Main St, Unit 4");
  });

  it("drops non-residential rows", () => {
    const land = ROW.replace("Single Family Residential", "Vacant Land");
    const { rows, skipped } = parseSoldCsv(`${HEADER}\n${land}`);
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("skips rows missing coordinates rather than inventing them", () => {
    const noCoords = ROW.replace("33.4484,-112.0740", ",");
    const { rows, skipped } = parseSoldCsv(`${HEADER}\n${noCoords}`);
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("leaves optional numerics null instead of coercing to zero", () => {
    const sparse =
      "May-4-2026,Townhouse,9 Oak Ave,Mesa,AZ,85201,,,,,,,33.1,-111.9,";
    const { rows } = parseSoldCsv(`${HEADER}\n${sparse}`);
    expect(rows[0]!.price).toBeNull();
    expect(rows[0]!.beds).toBeNull();
    expect(rows[0]!.yearBuilt).toBeNull();
  });

  it("strips $ and commas from price", () => {
    const priced = ROW.replace(",438000,", ',"$438,000",');
    const { rows } = parseSoldCsv(`${HEADER}\n${priced}`);
    expect(rows[0]!.price).toBe(438000);
  });

  it("accepts ISO sold dates as well as Redfin's format", () => {
    const iso = ROW.replace("May-4-2026", "2026-05-04");
    const { rows } = parseSoldCsv(`${HEADER}\n${iso}`);
    expect(rows[0]!.soldDate).toBe("2026-05-04");
  });

  it("ignores blank lines and trailing newlines", () => {
    const { rows } = parseSoldCsv(`${HEADER}\n${ROW}\n\n`);
    expect(rows).toHaveLength(1);
  });

  // The failure this whole design exists to prevent: a parser break must never
  // look like a quiet week. Bytes in + zero recognizable rows = hard error.
  it("throws when the header is unrecognizable", () => {
    expect(() => parseSoldCsv("total garbage\nmore garbage")).toThrow(SoldFeedParseError);
  });

  it("throws on empty input", () => {
    expect(() => parseSoldCsv("")).toThrow(SoldFeedParseError);
  });

  // A header with no data rows is a legitimately empty week, not a break.
  it("returns empty for a header with no rows", () => {
    const { rows } = parseSoldCsv(HEADER);
    expect(rows).toHaveLength(0);
  });
});

describe("priceBands", () => {
  it("covers the full range with no gaps or overlaps", () => {
    const bands = priceBands();
    expect(bands[0]!.min).toBe(0);
    expect(bands[bands.length - 1]!.max).toBeNull(); // open-ended top band
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.min).toBe(bands[i - 1]!.max);
    }
  });
});

describe("dedupeSoldRows", () => {
  const base = { address: "123 Main St", zip: "85001", lat: 1, lng: 2, soldDate: "2026-05-04" };

  it("collapses the same home appearing in two price-band tiles", () => {
    const out = dedupeSoldRows([
      { ...base, mls: "111" },
      { ...base, mls: "111" },
    ] as never);
    expect(out).toHaveLength(1);
  });

  it("keeps distinct homes", () => {
    const out = dedupeSoldRows([
      { ...base, mls: "111" },
      { ...base, mls: "222" },
    ] as never);
    expect(out).toHaveLength(2);
  });

  it("keeps the first occurrence", () => {
    const out = dedupeSoldRows([
      { ...base, mls: "111", price: 100 },
      { ...base, mls: "111", price: 999 },
    ] as never);
    expect(out[0]!.price).toBe(100);
  });
});
