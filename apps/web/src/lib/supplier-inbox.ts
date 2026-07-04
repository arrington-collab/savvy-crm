import "server-only";
import { randomBytes } from "node:crypto";
import { adminDb, tenant, eq } from "@savvy/db";
import { deriveInboxAddress } from "@savvy/core";
import { getTenantId } from "./tenant";

const DOMAIN = process.env.INBOX_DOMAIN ?? "inbox.getsavvy.com";

/** The tenant's supplier-invoice forwarding address, minting + persisting a token on first use. */
export async function ensureSupplierInboxAddress(): Promise<string> {
  const tenantId = await getTenantId();
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings ?? {}) as { supplierInbox?: { token?: string } };
  let token = settings.supplierInbox?.token;
  if (!token) {
    token = randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
    await adminDb.update(tenant).set({ settings: { ...settings, supplierInbox: { token } } }).where(eq(tenant.id, tenantId));
  }
  return deriveInboxAddress(token, DOMAIN);
}
