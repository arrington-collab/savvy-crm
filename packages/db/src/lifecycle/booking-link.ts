import { eq, and, isNull, gte, or } from "drizzle-orm";
import { adminDb } from "../admin-client.js";
import { bookingLink } from "../schema/index.js";
import { randomShortCode } from "@savvy/core";

/**
 * Creates a short booking link. Retries up to 5 times on unique-code collision.
 * Returns the generated code.
 */
export async function createBookingLink(args: {
  tenantId: string;
  token: string;
  expiresAt?: Date | null;
}): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShortCode();
    try {
      await adminDb.insert(bookingLink).values({
        tenantId: args.tenantId,
        code,
        token: args.token,
        expiresAt: args.expiresAt ?? null,
      });
      return code;
    } catch (err: unknown) {
      // Postgres unique violation = code 23505; retry
      if (err instanceof Error && err.message.includes("23505")) continue;
      throw err;
    }
  }
  throw new Error("Failed to generate unique booking link code after 5 attempts");
}

/**
 * Resolves a short code to its token. Returns null if not found or expired.
 */
export async function resolveBookingLink(code: string): Promise<string | null> {
  const now = new Date();
  const [row] = await adminDb
    .select({ token: bookingLink.token })
    .from(bookingLink)
    .where(
      and(
        eq(bookingLink.code, code),
        or(isNull(bookingLink.expiresAt), gte(bookingLink.expiresAt, now)),
      ),
    );
  return row?.token ?? null;
}
