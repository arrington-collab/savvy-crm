/**
 * Normalize any common phone format to E.164.
 * US-centric: 10 digits -> +1XXXXXXXXXX, 11 digits starting with 1 -> +1...,
 * a leading "+" with 7-15 digits passes through. Returns null if it cannot
 * be normalized to a valid-length number.
 */
export function normalizePhone(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (hasPlus) {
    return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** E.164 -> friendly display. US numbers become (480) 555-1234; others unchanged. */
export function formatPhoneDisplay(e164: string): string {
  if (!e164) return "";
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** True only for a US 5-digit ZIP (zip drives territory assignment). */
export function isValidZip(raw: string | null | undefined): boolean {
  return typeof raw === "string" && /^\d{5}$/.test(raw.trim());
}
