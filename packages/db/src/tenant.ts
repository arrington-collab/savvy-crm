import { sql } from "drizzle-orm";
import { db } from "./client";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `fn` inside a transaction with app.tenant_id set transaction-locally.
 * set_config(..., true) scopes the GUC to the tx, so a pooled connection is
 * never left with stale tenant context. Every app DB access goes through this.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
