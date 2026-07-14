"use server";
// Customer for Life slice 3, Play B: the tokenized warranty-transfer page.
// The token carries {tenantId, transferId} — no auth, same rails as /status.

import { requireSecret, verifyPayloadToken, parseMovePlayConfig } from "@savvy/core";
import { getWarrantyTransferOffer, registerWarrantyTransfer, withTenant, tenant as tenantTbl, eq } from "@savvy/db";

function transferPayload(token: string): { tenantId: string; transferId: string } | null {
  const secret = requireSecret("UNSUBSCRIBE_SECRET", { devFallback: "dev-unsubscribe-secret" });
  const p = verifyPayloadToken<{ tenantId: string; transferId: string }>(token, secret);
  return p?.tenantId && p?.transferId ? p : null;
}

export async function getTransferOfferByToken(token: string) {
  const payload = transferPayload(token);
  if (!payload) return { error: "invalid" as const };
  const offer = await getWarrantyTransferOffer(payload.tenantId, payload.transferId);
  if (!offer) return { error: "invalid" as const };
  const [t] = await withTenant(payload.tenantId, (tx) =>
    tx.select({ settings: tenantTbl.settings }).from(tenantTbl).where(eq(tenantTbl.id, payload.tenantId)));
  const cfg = parseMovePlayConfig((t?.settings as { movePlay?: unknown } | null)?.movePlay);
  return { ...offer, terms: cfg.terms, feeCents: cfg.transferFeeCents };
}

export async function registerTransferByToken(
  token: string,
  form: { name: string; phone?: string; email?: string },
): Promise<{ ok: true } | { error: "invalid" | "already_registered" | "missing_name" }> {
  const payload = transferPayload(token);
  if (!payload) return { error: "invalid" };
  const name = form.name?.trim();
  if (!name) return { error: "missing_name" };
  const res = await registerWarrantyTransfer({
    tenantId: payload.tenantId, transferId: payload.transferId,
    name, phone: form.phone?.trim() || undefined, email: form.email?.trim() || undefined,
  });
  if ("error" in res) return { error: res.error === "already_registered" ? "already_registered" : "invalid" };
  return { ok: true };
}
