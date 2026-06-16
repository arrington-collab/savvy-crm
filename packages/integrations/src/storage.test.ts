import { describe, it, expect } from "vitest";
import { makeFakeStorage } from "./storage";

describe("makeFakeStorage", () => {
  it("returns deterministic urls + records calls", async () => {
    const s = makeFakeStorage();
    const up = await s.presignUpload({ key: "t/j/x.jpg", contentType: "image/jpeg" });
    const dn = await s.presignDownload({ key: "t/j/x.jpg" });
    expect(up.url).toContain("t/j/x.jpg");
    expect(dn.url).toContain("sig=get");
    expect(s.calls.map((c) => c.op)).toEqual(["upload", "download"]);
  });
});
