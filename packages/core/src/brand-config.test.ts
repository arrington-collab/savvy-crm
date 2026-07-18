import { describe, it, expect } from "vitest";
import { parseBrandConfig, brandAccentVars } from "./brand-config";

describe("parseBrandConfig", () => {
  it("defaults to no branding (Savvy chrome)", () => {
    expect(parseBrandConfig(undefined)).toEqual({ name: null, logoUrl: null, accent: null });
    expect(parseBrandConfig(null)).toEqual({ name: null, logoUrl: null, accent: null });
    expect(parseBrandConfig({})).toEqual({ name: null, logoUrl: null, accent: null });
  });

  it("accepts a full brand", () => {
    const b = parseBrandConfig({ name: "Alta Roofing", logoUrl: "data:image/svg+xml;base64,abc", accent: "#b0752b" });
    expect(b).toEqual({ name: "Alta Roofing", logoUrl: "data:image/svg+xml;base64,abc", accent: "#b0752b" });
  });

  it("rejects a malformed accent (never injects junk into CSS)", () => {
    expect(parseBrandConfig({ accent: "red" }).accent).toBeNull();
    expect(parseBrandConfig({ accent: "#12" }).accent).toBeNull();
    expect(parseBrandConfig({ accent: "#b0752b; background:url(x)" }).accent).toBeNull();
    expect(parseBrandConfig({ accent: "#B0752B" }).accent).toBe("#B0752B"); // case-tolerant
  });

  it("only allows data: or https: logo urls", () => {
    expect(parseBrandConfig({ logoUrl: "javascript:alert(1)" }).logoUrl).toBeNull();
    expect(parseBrandConfig({ logoUrl: "https://cdn.example.com/logo.svg" }).logoUrl).toBe("https://cdn.example.com/logo.svg");
  });
});

describe("brandAccentVars", () => {
  it("derives the four accent variables from one base hex", () => {
    const vars = brandAccentVars("#b0752b");
    expect(vars["--accent-gold"]).toBe("#b0752b");
    // bright = mixed toward white, deep = mixed toward black — still valid hex
    expect(vars["--accent-bright"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars["--accent-deep"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars["--accent-006"]).toBe("rgba(176, 117, 43, 0.06)");
  });

  it("bright is lighter and deep is darker than the base", () => {
    const vars = brandAccentVars("#b0752b");
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(vars["--accent-bright"]!)).toBeGreaterThan(lum("#b0752b"));
    expect(lum(vars["--accent-deep"]!)).toBeLessThan(lum("#b0752b"));
  });
});
