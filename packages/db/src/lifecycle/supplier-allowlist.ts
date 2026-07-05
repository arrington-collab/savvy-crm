import { and, eq, asc } from "drizzle-orm";
import { withTenant } from "../tenant";
import { supplierAllowlist } from "../schema/index";

const norm = (d: string) => d.trim().toLowerCase();

/** All allow-list rows for the settings UI. */
export async function listSupplierAllowlist(tenantId: string): Promise<{ id: string; domain: string; label: string | null; createdAt: Date }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ id: supplierAllowlist.id, domain: supplierAllowlist.domain, label: supplierAllowlist.label, createdAt: supplierAllowlist.createdAt })
      .from(supplierAllowlist).where(eq(supplierAllowlist.tenantId, tenantId)).orderBy(asc(supplierAllowlist.domain)));
}

/** Just the domains — the handler gate. */
export async function listAllowedDomains(tenantId: string): Promise<string[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ domain: supplierAllowlist.domain }).from(supplierAllowlist).where(eq(supplierAllowlist.tenantId, tenantId)));
  return rows.map((r) => r.domain);
}

/** Add a domain (lowercased). Idempotent on the (tenant, domain) unique index. */
export async function addSupplierAllowlistDomain(tenantId: string, input: { domain: string; label?: string | null }): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(supplierAllowlist)
      .values({ tenantId, domain: norm(input.domain), label: input.label ?? null })
      .onConflictDoNothing({ target: [supplierAllowlist.tenantId, supplierAllowlist.domain] })
      .returning({ id: supplierAllowlist.id });
    if (row) return { id: row.id };
    // already existed → return the existing id
    const [existing] = await tx.select({ id: supplierAllowlist.id }).from(supplierAllowlist)
      .where(and(eq(supplierAllowlist.tenantId, tenantId), eq(supplierAllowlist.domain, norm(input.domain))));
    return { id: existing!.id };
  });
}

/** Remove one domain by id. */
export async function removeSupplierAllowlistDomain(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.delete(supplierAllowlist).where(and(eq(supplierAllowlist.tenantId, tenantId), eq(supplierAllowlist.id, id))));
}
