import { describe, it, expect } from "vitest";
import { parseBrandConfig, brandAccentVars, brandThemeVars } from "./brand-config";

describe("parseBrandConfig", () => {
  it("defaults to no branding (Savvy chrome)", () => {
    expect(parseBrandConfig(undefined)).toEqual({ name: null, logoUrl: null, accent: null, theme: null });
    expect(parseBrandConfig(null)).toEqual({ name: null, logoUrl: null, accent: null, theme: null });
    expect(parseBrandConfig({})).toEqual({ name: null, logoUrl: null, accent: null, theme: null });
  });

  it("accepts a full brand", () => {
    const b = parseBrandConfig({ name: "Alta Roofing", logoUrl: "data:image/svg+xml;base64,abc", accent: "#b0752b", theme: "light" });
    expect(b).toEqual({ name: "Alta Roofing", logoUrl: "data:image/svg+xml;base64,abc", accent: "#b0752b", theme: "light" });
  });

  it("only recognizes the light theme; junk falls back to default dark", () => {
    expect(parseBrandConfig({ theme: "light" }).theme).toBe("light");
    expect(parseBrandConfig({ theme: "dark" }).theme).toBeNull();
    expect(parseBrandConfig({ theme: "cream; url(x)" }).theme).toBeNull();
    expect(parseBrandConfig({ theme: 42 }).theme).toBeNull();
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

describe("brandThemeVars", () => {
  const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);

  it("returns undefined when there is nothing to override (default Savvy chrome)", () => {
    expect(brandThemeVars(parseBrandConfig({}))).toBeUndefined();
  });

  it("accent without a theme yields only the four dark-chrome accent vars (existing behavior)", () => {
    const vars = brandThemeVars(parseBrandConfig({ accent: "#b0722c" }))!;
    expect(vars["--accent-gold"]).toBe("#b0722c");
    expect(vars["--background"]).toBeUndefined();
    expect(Object.keys(vars)).toHaveLength(4);
  });

  it("light theme carries the cream surface palette", () => {
    const vars = brandThemeVars(parseBrandConfig({ accent: "#b0722c", theme: "light" }))!;
    expect(vars["--background"]).toBe("#f0eee5");
    expect(vars["--card"]).toBe("#fcfbf7");
    expect(vars["--text-primary"]).toBe("#1f1e1b");
    expect(vars["--border-panel"]).toBe("#e5e1d4");
    expect(vars["--surface-app"]).toContain("#f0eee5");
    expect(vars["--primary"]).toBe("#b0722c");
    expect(vars["--ring"]).toBe("#b0722c");
  });

  it("light theme inverts accent emphasis: bright and deep are DARKER than the base", () => {
    const vars = brandThemeVars(parseBrandConfig({ accent: "#b0722c", theme: "light" }))!;
    expect(lum(vars["--accent-bright"]!)).toBeLessThan(lum("#b0722c"));
    expect(lum(vars["--accent-deep"]!)).toBeLessThan(lum(vars["--accent-bright"]!));
  });

  it("light theme without an accent falls back to the canvass copper", () => {
    const vars = brandThemeVars(parseBrandConfig({ theme: "light" }))!;
    expect(vars["--accent-gold"]).toBe("#b0722c");
    expect(vars["--background"]).toBe("#f0eee5");
  });

  it("light theme swaps status/persona colors to light-legible values", () => {
    const vars = brandThemeVars(parseBrandConfig({ theme: "light" }))!;
    expect(vars["--status-ok"]).toBe("#3d7a44");
    expect(vars["--status-error"]).toBe("#c0392b");
    // persona colors must darken vs the dark-chrome originals to stay readable on cream
    expect(lum(vars["--agent-vera"]!)).toBeLessThan(lum("#93a26a"));
    expect(lum(vars["--agent-milo"]!)).toBeLessThan(lum("#5fa6a0"));
  });
});
