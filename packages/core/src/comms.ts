import { createHmac } from "node:crypto";

const STOP_WORDS = new Set(["stop", "unsubscribe", "cancel"]);

/** True if the whole (trimmed) SMS body is a stop keyword. */
export function isStopKeyword(body: string): boolean {
  return STOP_WORDS.has(body.trim().toLowerCase());
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Signed, URL-safe unsubscribe token: `<customerId>.<hmac>`. */
export function signUnsubToken(customerId: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(customerId).digest();
  return `${b64url(Buffer.from(customerId))}.${b64url(sig)}`;
}

/** Returns the customerId if the token is valid, else null. */
export function verifyUnsubToken(token: string, secret: string): string | null {
  const [idPart, sigPart] = token.split(".");
  if (!idPart || !sigPart) return null;
  let customerId: string;
  try {
    customerId = Buffer.from(idPart, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = b64url(createHmac("sha256", secret).update(customerId).digest());
  return expected === sigPart ? customerId : null;
}
