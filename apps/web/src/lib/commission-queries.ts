import "server-only";
import { withTenant, commission, invoice, user, eq, desc } from "@savvy/db";
import { getTenantId } from "./tenant";

export async function listCommissions() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select({
      id: commission.id,
      amountCents: commission.amountCents,
      basisCents: commission.basisCents,
      rate: commission.rate,
      model: commission.model,
      status: commission.status,
      periodKey: commission.periodKey,
      invoiceNumber: invoice.number,
      repName: user.name,
    })
      .from(commission)
      .leftJoin(invoice, eq(invoice.id, commission.invoiceId))
      .leftJoin(user, eq(user.id, commission.userId))
      .orderBy(desc(commission.createdAt)),
  );
}
