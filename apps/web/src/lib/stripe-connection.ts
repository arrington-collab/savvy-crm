import "server-only";
import { adminDb, tenant, eq } from "@savvy/db";

export async function getStripeConnection(tenantId: string): Promise<{ connected: boolean; accountId?: string }> {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  return t?.stripeAccountId ? { connected: true, accountId: t.stripeAccountId } : { connected: false };
}
