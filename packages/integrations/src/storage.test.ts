import { describe, it, test, expect } from "vitest";
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

test("makeFakeStorage.putObject records the call", async () => {
  const s = makeFakeStorage();
  await s.putObject({ key: "t/j/file.pdf", bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" });
  expect(s.calls).toContainEqual({ op: "put", key: "t/j/file.pdf" });
});
