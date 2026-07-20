import { describe, it, expect } from "vitest";
import { htmlToText } from "./html-to-text";

describe("htmlToText", () => {
  it("returns plain text unchanged (trimmed)", () => {
    expect(htmlToText("Sandra chelsea and christopher")).toBe("Sandra chelsea and christopher");
    expect(htmlToText("  hi  ")).toBe("hi");
  });

  it("converts <br> and block tags to line breaks", () => {
    expect(htmlToText("Supplement<br> <br>Colorado Sales tax 8.2%<br>Distribution fee")).toBe(
      "Supplement\n\nColorado Sales tax 8.2%\nDistribution fee",
    );
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One\nTwo");
    expect(htmlToText("a</div><div>b")).toBe("a\nb");
  });

  it("drops head/style/script content entirely", () => {
    const h = `<!DOCTYPE html><html><head><title>x</title><style>.a{color:red}</style></head><body>Hello <b>world</b></body></html>`;
    expect(htmlToText(h)).toBe("Hello world");
  });

  it("strips all remaining tags and their attributes", () => {
    expect(htmlToText('<a href="https://x.com" target="_blank">View Report</a>')).toBe("View Report");
    expect(htmlToText('<img src="x.png" alt="logo"/>keep')).toBe("keep");
  });

  it("decodes common HTML entities", () => {
    expect(htmlToText("Tom &amp; Jerry &lt;3 &gt; &quot;hi&quot; &#39;q&#39;")).toBe('Tom & Jerry <3 > "hi" \'q\'');
    expect(htmlToText("a&nbsp;b")).toBe("a b");
    expect(htmlToText("x\u00a0y")).toBe("x y"); // literal nbsp char
  });

  it("collapses runs of blank lines and trailing spaces", () => {
    expect(htmlToText("a<br><br><br><br>b")).toBe("a\n\nb"); // 3+ breaks → at most one blank line
    expect(htmlToText("line   with    spaces")).toBe("line with spaces");
  });

  it("null/empty → empty string", () => {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
    expect(htmlToText("")).toBe("");
  });

  it("flattens a real AccuLynx email table to readable text (no tags, no css)", () => {
    const email = `<!DOCTYPE html><html><head><style>.email-body__heading--blue{color:#4680bf}</style></head>` +
      `<body><table><tr><td><h1>EagleView&trade; is Ready!</h1></td></tr>` +
      `<tr><td>The measurement has been created for: <strong><a href="https://my.acculynx.com/jobs/x">13: Christopher Curl</a></strong></td></tr>` +
      `<tr><td>Ordered:</td><td>06/29/2026</td></tr></table></body></html>`;
    const out = htmlToText(email);
    expect(out).not.toContain("<");
    expect(out).not.toContain("color:");
    expect(out).toContain("EagleView™ is Ready!");
    expect(out).toContain("13: Christopher Curl");
    expect(out).toContain("Ordered:");
  });
});
