import { describe, it, expect } from "vitest";
import { shortenUrl, linkifyBody } from "./linkify";

describe("shortenUrl", () => {
  it("drops the protocol and truncates a long path", () => {
    const url = "https://savvy-crm.vercel.app/book/" + "e".repeat(200);
    const s = shortenUrl(url);
    expect(s.startsWith("savvy-crm.vercel.app/book/")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThan(40);
  });

  it("leaves a short link unshortened (minus protocol)", () => {
    expect(shortenUrl("https://savvy-crm.vercel.app/b/p3IKKNaa")).toBe("savvy-crm.vercel.app/b/p3IKKNaa");
  });
});

describe("linkifyBody", () => {
  it("splits a message into leading text and a link segment", () => {
    const body = "Book here: https://savvy-crm.vercel.app/b/p3IKKNaa";
    expect(linkifyBody(body)).toEqual([
      { type: "text", value: "Book here: " },
      { type: "link", value: "savvy-crm.vercel.app/b/p3IKKNaa", href: "https://savvy-crm.vercel.app/b/p3IKKNaa" },
    ]);
  });

  it("keeps trailing text after the url", () => {
    const body = "Reschedule: https://savvy-crm.vercel.app/b/abc Reply CANCEL to cancel.";
    const segs = linkifyBody(body);
    expect(segs.map((s) => s.type)).toEqual(["text", "link", "text"]);
    expect(segs[2]).toEqual({ type: "text", value: " Reply CANCEL to cancel." });
  });

  it("returns a single text segment when there is no url", () => {
    expect(linkifyBody("No link here")).toEqual([{ type: "text", value: "No link here" }]);
  });
});
