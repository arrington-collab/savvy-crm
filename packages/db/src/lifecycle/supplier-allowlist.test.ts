import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, supplierAllowlist, eq } from "../index";
import { listSupplierAllowlist, listAllowedDomains, addSupplierAllowlistDomain, removeSupplierAllowlistDomain } from "./supplier-allowlist";

let tenantId: string;
beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "AL Co", publicKey: `al-${tenantId.slice(0, 8)}` });
});
afterAll(async () => {
  await adminDb.delete(supplierAllowlist).where(eq(supplierAllowlist.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("add → list → listAllowedDomains → remove, lowercasing + idempotent", async () => {
  const { id } = await addSupplierAllowlistDomain(tenantId, { domain: "ABCSupply.com", label: "ABC" });
  await addSupplierAllowlistDomain(tenantId, { domain: "abcsupply.com" }); // idempotent (unique)
  const rows = await listSupplierAllowlist(tenantId);
  expect(rows.map((r) => r.domain)).toEqual(["abcsupply.com"]);
  expect(await listAllowedDomains(tenantId)).toEqual(["abcsupply.com"]);
  await removeSupplierAllowlistDomain(tenantId, id);
  expect(await listAllowedDomains(tenantId)).toEqual([]);
});
