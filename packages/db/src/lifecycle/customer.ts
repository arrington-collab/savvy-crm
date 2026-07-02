import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { withTenant } from "../tenant";
import { customer } from "../schema/index";

export type EmailSource = "self_reported" | "appended";

export interface CustomerEmailDue {
  customerId: string;
  name: string;
  phone: string | null;
}

/** Emailless customers that have a phone to look up by — candidates for append. */
export async function findCustomersNeedingEmail(tenantId: string, limit: number): Promise<CustomerEmailDue[]> {
  return withTenant(tenantId, (tx) =>
    tx
      .select({ customerId: customer.id, name: customer.name, phone: customer.phone })
      .from(customer)
      .where(and(isNull(customer.email), isNotNull(customer.phone)))
      .limit(limit),
  );
}

/**
 * Set a customer's email + provenance. Policy:
 * - "self_reported" (homeowner gave it) is authoritative and always overwrites.
 * - "appended" (data-broker skip-trace) only fills when there is NO email — it
 *   must never clobber a homeowner-given address. Returns whether a write happened.
 */
export async function setCustomerEmail(
  tenantId: string,
  input: { customerId: string; email: string; source: EmailSource },
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const [cur] = await tx
      .select({ email: customer.email })
      .from(customer)
      .where(eq(customer.id, input.customerId));
    if (!cur) return false;
    if (input.source === "appended" && cur.email) return false;
    await tx
      .update(customer)
      .set({ email: input.email, emailSource: input.source })
      .where(eq(customer.id, input.customerId));
    return true;
  });
}
