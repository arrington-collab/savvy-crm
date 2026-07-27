import { renderTemplate } from "./render-template";

export type Language = "en" | "es";

/** "es" iff `v` lowercased starts with "es" (covers "es", "es-MX", ...); everything else, including
 *  null/undefined, normalizes to "en". */
export function normalizeLanguage(v: string | null | undefined): Language {
  return v?.toLowerCase().startsWith("es") ? "es" : "en";
}

/** Picks the EN/ES variant matching `normalizeLanguage(language)`. */
export function pickLocalizedBody(variants: { en: string; es: string }, language: string | null | undefined): string {
  return variants[normalizeLanguage(language)];
}

/** Picks the localized variant and renders its {{var}} placeholders via `renderTemplate`. */
export function renderLocalized(
  variants: { en: string; es: string },
  language: string | null | undefined,
  vars: Record<string, string>,
): string {
  return renderTemplate(pickLocalizedBody(variants, language), vars);
}
