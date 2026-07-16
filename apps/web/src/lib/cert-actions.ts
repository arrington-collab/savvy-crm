"use server";
import { createCertRequest, bookCertRequest, declineCertRequest, findOrCreatePartner } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";

export async function createCertRequestAction(input: {
  partnerId?: string;
  partner?: { name: string; org?: string };
  customerName: string;
  customerEmail?: string;
  address: string;
}): Promise<{ ok: true } | { error: string }> {
  try {
    const tenantId = await getTenantId();
    let partnerId = input.partnerId ?? null;
    if (!partnerId && input.partner) {
      partnerId = (await findOrCreatePartner(tenantId, input.partner)).id;
    }
    if (!partnerId) return { error: "Pick a partner" };
    if (!input.customerName.trim() || !input.address.trim()) return { error: "Name and address are required" };
    const r = await createCertRequest(tenantId, {
      partnerId, customerName: input.customerName.trim(),
      customerEmail: input.customerEmail?.trim() || undefined, address: input.address.trim(),
    });
    if ("error" in r) return { error: r.error === "cert_lane_disabled" ? "The cert lane is disabled for this tenant" : r.error };
    revalidatePath("/partners/certs");
    return { ok: true };
  } catch {
    return { error: "could not create cert request" };
  }
}

export async function bookCertRequestAction(input: {
  certRequestId: string;
  assigneeUserId: string;
  startsAtIso: string;
  durationMin?: number;
}): Promise<{ ok: true } | { error: string }> {
  try {
    const tenantId = await getTenantId();
    const startsAt = new Date(input.startsAtIso);
    if (Number.isNaN(startsAt.getTime())) return { error: "invalid start time" };
    const endsAt = new Date(startsAt.getTime() + (input.durationMin ?? 60) * 60_000);
    const r = await bookCertRequest(tenantId, {
      certRequestId: input.certRequestId, assigneeUserId: input.assigneeUserId, startsAt, endsAt,
    });
    if ("error" in r) return { error: r.error };
    revalidatePath("/partners/certs");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error && e.message === "slot_taken" ? "That slot is taken" : "could not book" };
  }
}

export async function declineCertRequestAction(
  certRequestId: string,
  reason: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    const tenantId = await getTenantId();
    await declineCertRequest(tenantId, { certRequestId, reason: reason.trim() || "declined" });
    revalidatePath("/partners/certs");
    return { ok: true };
  } catch {
    return { error: "could not decline" };
  }
}
