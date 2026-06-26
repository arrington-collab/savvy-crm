const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Returns an 8-character URL-safe base62 code.
 * Accepts optional random bytes for deterministic testing.
 */
export function randomShortCode(bytes?: Uint8Array): string {
  const buf = bytes ?? crypto.getRandomValues(new Uint8Array(8));
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += CHARS[buf[i]! % 62];
  }
  return result;
}
