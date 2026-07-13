"use server";
import { withTenant, tenant, eq, sql } from "@savvy/db";
import { parseWhyUsConfig, type WhyUsConfig } from "@savvy/core";
import { getTenantId } from "./tenant";

export async function saveWhyUs(input: WhyUsConfig): Promise<void> {
  const tenantId = await getTenantId();
  const cfg = parseWhyUsConfig(input); // validate/trim through the schema
  await withTenant(tenantId, (tx) =>
    tx
      .update(tenant)
      .set({ settings: sql`coalesce(${tenant.settings}, '{}'::jsonb) || jsonb_build_object('whyUs', ${JSON.stringify(cfg)}::jsonb)` })
      .where(eq(tenant.id, tenantId)),
  );
}
