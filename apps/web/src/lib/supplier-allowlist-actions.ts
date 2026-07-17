"use server";
import { revalidatePath } from "next/cache";
import { addSupplierAllowlistDomain, removeSupplierAllowlistDomain } from "@savvy/db";
import { getTenantId } from "./tenant";
import { canManageSettingsNow } from "./authz";

// Accept a domain or a full email; store just the lowercased domain part.
function toDomain(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  const dom = v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v;
  // basic domain shape: label.tld, no spaces/@
  return /^[^\s@]+\.[^\s@]+$/.test(dom) ? dom : null;
}

export async function addSupplierDomain(formData: FormData): Promise<{ error?: string }> {
  if (!(await canManageSettingsNow())) return { error: "Not authorized" };
  const tenantId = await getTenantId();
  const domain = toDomain(String(formData.get("domain") ?? ""));
  if (!domain) return { error: "Enter a valid domain (e.g. abcsupply.com)." };
  const label = String(formData.get("label") ?? "").trim() || null;
  await addSupplierAllowlistDomain(tenantId, { domain, label });
  revalidatePath("/settings/suppliers");
  return {};
}

export async function removeSupplierDomain(id: string): Promise<{ error?: string }> {
  if (!(await canManageSettingsNow())) return { error: "Not authorized" };
  const tenantId = await getTenantId();
  await removeSupplierAllowlistDomain(tenantId, id);
  revalidatePath("/settings/suppliers");
  return {};
}
