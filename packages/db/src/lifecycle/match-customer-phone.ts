import { eq, isNotNull } from "drizzle-orm";
import { normalizePhone } from "@savvy/core";
import { customer } from "../schema/index";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

/**
 * Matches an inbound SMS sender to a customer by phone, tenant-scoped (call
 * inside withTenant). Mirrors contact-suppression.ts's normalize-both-sides
 * approach so a customer whose stored `phone` is non-E.164 (a plausible data
 * state — nothing enforces the format at write time) still matches an E.164
 * inbound number, and vice versa.
 *
 * Three passes, cheapest first:
 *  1. Exact match on the normalized inbound value (covers stored-normalized rows).
 *  2. Exact match on the raw inbound value (covers stored === raw `from`).
 *  3. Bounded per-tenant scan comparing normalized forms (covers a stored
 *     NON-E.164 phone). Inbound webhook handling is one message at a time
 *     (low volume), so this scan is acceptable here.
 */
export async function matchCustomerByPhone(tx: Tx, from: string) {
  const norm = normalizePhone(from);

  if (norm) {
    const [row] = await tx.select().from(customer).where(eq(customer.phone, norm)).limit(1);
    if (row) return row;
  }

  const [raw] = await tx.select().from(customer).where(eq(customer.phone, from)).limit(1);
  if (raw) return raw;

  if (!norm) return null;
  const candidates = await tx.select().from(customer).where(isNotNull(customer.phone));
  return candidates.find((c) => normalizePhone(c.phone ?? "") === norm) ?? null;
}
