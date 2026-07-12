export type CrewLanguage = "en" | "es";

/** Strip accents/diacritics so "ESPAÑOL" and "espanol" both match. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Detect a self-service language flip from a free-text crew reply. Returns the
 * requested language, or null when the message isn't a flip. Accent-insensitive.
 */
export function parseLanguageFlip(body: string): CrewLanguage | null {
  const t = fold(body);
  if (/\b(espanol|spanish)\b/.test(t)) return "es";
  if (/\b(english|ingles)\b/.test(t)) return "en";
  return null;
}

/** Confirm the flip in the NEW language (so the recipient sees it worked). */
export function languageFlipConfirmation(lang: CrewLanguage): string {
  return lang === "es"
    ? "¡Listo! Ahora recibirás los mensajes en español."
    : "Done — you'll now get messages in English.";
}

/**
 * Library template key for a language. English uses the base key; Spanish uses
 * a `.es` variant row (professionally phrased, versioned in message_template).
 */
export function selectTemplateKey(baseKey: string, lang: CrewLanguage): string {
  return lang === "es" ? `${baseKey}.es` : baseKey;
}

/**
 * Translate a dynamic fragment with a hard fail-soft: English passes through
 * untouched; a translation failure returns the English text FLAGGED (never
 * silence). `translate` is injected (the cheap gateway capability at the call site).
 */
export async function translateWithFallback(
  text: string,
  lang: CrewLanguage,
  translate: (text: string) => Promise<string>,
): Promise<{ text: string; translated: boolean; failed: boolean }> {
  if (lang === "en") return { text, translated: false, failed: false };
  try {
    return { text: await translate(text), translated: true, failed: false };
  } catch {
    return { text, translated: false, failed: true };
  }
}
