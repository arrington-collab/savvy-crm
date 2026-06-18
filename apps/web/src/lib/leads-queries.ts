import "server-only";
import { withTenant, lead, customer, property, user, communication, count, eq, desc, sql } from "@savvy/db";
import { LEAD_STATUS, type LeadStatus } from "@savvy/core";
import { getTenantId } from "./tenant";

export type LeadListRow = {
  id: string;
  status: string;
  score: number | null;
  source: string | null;
  customerName: string | null;
  address: string | null;
  createdAt: Date;
};

export async function getLeads(
  opts: { status?: LeadStatus; sort?: "score" | "age" } = {},
): Promise<LeadListRow[]> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: lead.id,
        status: lead.status,
        score: lead.score,
        source: lead.source,
        customerName: customer.name,
        address: property.address,
        createdAt: lead.createdAt,
      })
      .from(lead)
      .leftJoin(customer, eq(customer.id, lead.customerId))
      .leftJoin(property, eq(property.id, lead.propertyId))
      // undefined omits the WHERE clause (Drizzle no-op) — no status filter
      .where(opts.status ? eq(lead.status, opts.status) : undefined)
      .orderBy(
        ...(opts.sort === "age"
          ? [desc(lead.createdAt)]
          : [sql`${lead.score} desc nulls last`, desc(lead.createdAt)]),
      ),
  );
}

export async function getLeadFunnelCounts(): Promise<Record<LeadStatus, number>> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ status: lead.status, n: count() }).from(lead).groupBy(lead.status),
  );
  const out = Object.fromEntries(LEAD_STATUS.map((s) => [s, 0])) as Record<LeadStatus, number>;
  for (const r of rows) out[r.status as LeadStatus] = r.n;
  return out;
}

export type LeadComm = {
  id: string;
  channel: string;
  direction: string;
  body: string | null;
  createdAt: Date;
};

export type LeadDetail = {
  id: string;
  status: string;
  score: number | null;
  scoreReason: string | null;
  source: string | null;
  customerName: string | null;
  phone: string | null;
  address: string | null;
  assignedUserId: string | null;
  ownerName: string | null;
  communications: LeadComm[];
};

export async function getLeadDetail(id: string): Promise<LeadDetail | null> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: lead.id,
        status: lead.status,
        score: lead.score,
        scoreReason: lead.scoreReason,
        source: lead.source,
        customerId: lead.customerId,
        customerName: customer.name,
        phone: customer.phone,
        address: property.address,
        assignedUserId: lead.assignedUserId,
        ownerName: user.name,
      })
      .from(lead)
      .leftJoin(customer, eq(customer.id, lead.customerId))
      .leftJoin(property, eq(property.id, lead.propertyId))
      .leftJoin(user, eq(user.id, lead.assignedUserId))
      .where(eq(lead.id, id))
      .limit(1);
    if (!row) return null;
    const communications: LeadComm[] = row.customerId
      ? await tx
          .select({
            id: communication.id,
            channel: communication.channel,
            direction: communication.direction,
            body: communication.body,
            createdAt: communication.createdAt,
          })
          .from(communication)
          .where(eq(communication.customerId, row.customerId))
          .orderBy(desc(communication.createdAt))
          .limit(20)
      : [];
    return {
      id: row.id,
      status: row.status,
      score: row.score,
      scoreReason: row.scoreReason,
      source: row.source,
      customerName: row.customerName,
      phone: row.phone,
      address: row.address,
      assignedUserId: row.assignedUserId,
      ownerName: row.ownerName,
      communications,
    };
  });
}
