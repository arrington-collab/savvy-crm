import { describe, it, expect } from "vitest";
import { httpCompanyCam, makeFakeCompanyCam } from "./companycam.js";

describe("companycam gateway", () => {
  it("fake parses a simple event and verifies open (no secret)", async () => {
    const cc = makeFakeCompanyCam();
    expect(cc.verifyWebhook("{}", null)).toBe(true);
    const ev = cc.parseEvent({ projectId: "p1", photoId: "ph1", url: "https://cc/x.jpg" });
    expect(ev).toEqual({ type: "photo.created", projectId: "p1", photoId: "ph1", url: "https://cc/x.jpg" });
    expect(cc.parseEvent({ projectId: "p1" })).toBeNull();
    const got = await cc.getPhoto({ connectionId: "c", photoId: "ph1" });
    expect(got.url).toContain("ph1");
    expect(cc.calls.some((c) => c.op === "getPhoto")).toBe(true);
  });
  it("http verifyWebhook allows when no secret is set, parses nested shape", () => {
    delete process.env.COMPANYCAM_WEBHOOK_SECRET;
    expect(httpCompanyCam.verifyWebhook("{}", null)).toBe(true);
    const ev = httpCompanyCam.parseEvent({
      type: "photo.created",
      data: { photo: { id: "9", project_id: "7", uris: [{ type: "original", uri: "https://cc/o.jpg" }] } },
    });
    expect(ev).toEqual({ type: "photo.created", projectId: "7", photoId: "9", url: "https://cc/o.jpg", capturedAt: undefined });
  });
});
