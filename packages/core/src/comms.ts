import { createHmac } from "node:crypto";

const STOP_WORDS = new Set(["stop", "unsubscribe", "end", "quit"]); // 'cancel' removed (Phase 4)

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

/** True if the whole (trimmed) SMS body is the appointment-cancel keyword. */
export function isCancelKeyword(body: string): boolean {
  return body.trim().toLowerCase() === "cancel";
}

/** Generic signed, URL-safe token: `<base64url(json)>.<hmac>`. */
export function signPayloadToken(payload: Record<string, string>, secret: string): string {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json).toString("base64url");
  const sig = createHmac("sha256", secret).update(data).digest().toString("base64url");
  return `${data}.${sig}`;
}

export function verifyPayloadToken<T = Record<string, string>>(token: string, secret: string): T | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = createHmac("sha256", secret).update(data).digest().toString("base64url");
  if (expected !== sig) return null;
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
