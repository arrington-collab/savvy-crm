import { it, expect } from "vitest";
import { normalizeLanguage, pickLocalizedBody, renderLocalized } from "./localized-templates";

it("normalizes language to en/es", () => {
  expect(normalizeLanguage("es")).toBe("es");
  expect(normalizeLanguage("es-MX")).toBe("es");
  expect(normalizeLanguage("en")).toBe("en");
  expect(normalizeLanguage(null)).toBe("en");
  expect(normalizeLanguage("fr")).toBe("en");
});

it("picks and renders the localized variant", () => {
  const v = { en: "Hi {{name}}", es: "Hola {{name}}" };
  expect(pickLocalizedBody(v, "es")).toBe("Hola {{name}}");
  expect(renderLocalized(v, "es", { name: "Ana" })).toBe("Hola Ana");
  expect(renderLocalized(v, null, { name: "Sam" })).toBe("Hi Sam");
});
