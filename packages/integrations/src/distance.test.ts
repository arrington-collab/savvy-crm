import { describe, it, expect } from "vitest";
import { makeFakeDistance, fakeDriveMinutes, type LatLng } from "./distance";

const mesa: LatLng = { lat: 33.42, lng: -111.83 };
const tempe: LatLng = { lat: 33.43, lng: -111.94 };
const far: LatLng = { lat: 34.5, lng: -112.5 };

describe("fakeDriveMinutes", () => {
  it("is zero for the same point", () => {
    expect(fakeDriveMinutes(mesa, mesa)).toBe(0);
  });
  it("grows with distance (nearer < farther)", () => {
    expect(fakeDriveMinutes(mesa, tempe)).toBeLessThan(fakeDriveMinutes(mesa, far));
  });
});

describe("makeFakeDistance", () => {
  it("returns a row-major minutes matrix [origins][dests]", async () => {
    const d = makeFakeDistance();
    const m = await d.driveMinutesMatrix([mesa, tempe], [far]);
    expect(m).not.toBeNull();
    expect(m!.length).toBe(2);
    expect(m![0].length).toBe(1);
    expect(typeof m![0][0]).toBe("number");
  });
  it("returns null for an empty origin or dest list", async () => {
    const d = makeFakeDistance();
    expect(await d.driveMinutesMatrix([], [far])).toBeNull();
    expect(await d.driveMinutesMatrix([mesa], [])).toBeNull();
  });
  it("counts calls (so callers can assert a single batched request)", async () => {
    const d = makeFakeDistance();
    await d.driveMinutesMatrix([mesa], [far]);
    await d.driveMinutesMatrix([tempe], [far]);
    expect(d.calls).toBe(2);
  });
});
