import { describe, it, expect } from "vitest";
import { parseLanguageFlip, languageFlipConfirmation, selectTemplateKey, translateWithFallback } from "./crew-language";

describe("parseLanguageFlip", () => {
  it("detects a Spanish request (with or without the tilde/accents, any case)", () => {
    expect(parseLanguageFlip("ESPAÑOL")).toBe("es");
    expect(parseLanguageFlip("espanol")).toBe("es");
    expect(parseLanguageFlip("Spanish please")).toBe("es");
  });

  it("detects an English request", () => {
    expect(parseLanguageFlip("ENGLISH")).toBe("en");
    expect(parseLanguageFlip("inglés")).toBe("en");
  });

  it("returns null for anything else", () => {
    expect(parseLanguageFlip("on my way")).toBeNull();
    expect(parseLanguageFlip("")).toBeNull();
  });
});

describe("languageFlipConfirmation", () => {
  it("confirms in the NEW language", () => {
    expect(languageFlipConfirmation("es")).toContain("español");
    expect(languageFlipConfirmation("en").toLowerCase()).toContain("english");
  });
});

describe("selectTemplateKey", () => {
  it("uses the base key for English and a .es variant for Spanish", () => {
    expect(selectTemplateKey("crew.schedule", "en")).toBe("crew.schedule");
    expect(selectTemplateKey("crew.schedule", "es")).toBe("crew.schedule.es");
  });
});

describe("translateWithFallback", () => {
  it("passes English through untouched (no translation call)", async () => {
    const r = await translateWithFallback("Materials arrive at 8am", "en", async () => "SHOULD NOT RUN");
    expect(r).toEqual({ text: "Materials arrive at 8am", translated: false, failed: false });
  });

  it("translates for Spanish", async () => {
    const r = await translateWithFallback("Materials arrive at 8am", "es", async () => "Los materiales llegan a las 8am");
    expect(r).toEqual({ text: "Los materiales llegan a las 8am", translated: true, failed: false });
  });

  it("fails soft to English (flagged) when translation throws — never silence", async () => {
    const r = await translateWithFallback("Materials arrive at 8am", "es", async () => {
      throw new Error("gateway down");
    });
    expect(r).toEqual({ text: "Materials arrive at 8am", translated: false, failed: true });
  });
});
