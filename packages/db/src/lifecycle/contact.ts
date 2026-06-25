import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { lead } from "../schema/index.js";

type Tx = Parameters<Parameters<typeof import("../client.js").db.transaction>[0]>[0];
const OPEN = ["new", "contacted", "qualified", "booked"] as const;

// Sets first_rep_contact_at = now() if currently null. Returns true iff it set it this call.
export async function markLeadContacted(tx: Tx, opts: { tenantId: string; leadId: string }): Promise<boolean> {
  const res = await tx.update(lead).set({ firstRepContactAt: sql`now()` })
    .where(and(eq(lead.id, opts.leadId), eq(lead.tenantId, opts.tenantId), isNull(lead.firstRepContactAt)))
    .returning({ id: lead.id });
  return res.length > 0;
}

// Marks all of a customer's OPEN, not-yet-contacted leads. Returns the ids it set.
export async function markCustomerLeadsContacted(tx: Tx, opts: { tenantId: string; customerId: string }): Promise<string[]> {
  const res = await tx.update(lead).set({ firstRepContactAt: sql`now()` })
    .where(and(eq(lead.tenantId, opts.tenantId), eq(lead.customerId, opts.customerId), isNull(lead.firstRepContactAt), inArray(lead.status, [...OPEN])))
    .returning({ id: lead.id });
  return res.map((r) => r.id);
}
