"use server";
import { adminDb, tenant, eq } from "@savvy/db";
import { parseSchedulingConfig } from "@savvy/core";
import { getTenantId } from "./tenant";
import { revalidatePath } from "next/cache";

// NOTE: We use adminDb (bypassing RLS) for reading and writing the tenant row
// because the tenant table is the RLS isolation root itself — savvy_app lacks
// UPDATE grant on it. Every other caller that reads or writes the tenant row
// (booking-action.ts:69, tenant.ts:18, intake.ts:6) also uses adminDb.
export async function saveSchedulingConfig(raw: unknown): Promise<{ ok: true } | { error: "invalid_config" }> {
  const tenantId = await getTenantId();
  let cfg;
  try {
    cfg = parseSchedulingConfig(raw);
  } catch {
    return { error: "invalid_config" as const };
  }
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  const next = { ...((t?.settings as object) ?? {}), scheduling: cfg };
  await adminDb.update(tenant).set({ settings: next }).where(eq(tenant.id, tenantId));
  revalidatePath("/settings/scheduling");
  return { ok: true as const };
}
