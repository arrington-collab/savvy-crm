import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a svix webhook signature (Clerk uses svix). Signed content is
 * `${id}.${timestamp}.${body}`; the secret is `whsec_<base64>`; the signature
 * header is space-separated `v1,<base64sig>` pairs. Fail-closed in production
 * when no secret is configured; allow in dev/test (parity with other webhooks).
 */
export function verifySvix(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
): boolean {
  if (!secret) return process.env.NODE_ENV !== "production";
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signature.split(" ").some((part) => {
    const b64 = part.split(",")[1] ?? "";
    let provided: Buffer;
    try { provided = Buffer.from(b64, "base64"); } catch { return false; }
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}
