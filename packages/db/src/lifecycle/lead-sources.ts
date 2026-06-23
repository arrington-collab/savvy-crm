import { eq } from "drizzle-orm";
import { tenant } from "../schema/index";
import { adminDb } from "../admin-client";

export async function getCustomLeadSources(tenantId: string): Promise<string[]> {
  const [t] = await adminDb
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const ls = (t?.settings as { leadSources?: unknown } | null)?.leadSources;
  return Array.isArray(ls) ? (ls as string[]) : [];
}

export async function addLeadSource(tenantId: string, source: string): Promise<string[]> {
  const clean = source.trim();
  if (!clean) throw new Error("empty source");
  const [t] = await adminDb
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const settings = (t?.settings ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(settings.leadSources)
    ? (settings.leadSources as string[])
    : [];
  if (existing.some((s) => s.toLowerCase() === clean.toLowerCase())) return existing;
  const updated = [...existing, clean];
  await adminDb
    .update(tenant)
    .set({ settings: { ...settings, leadSources: updated } })
    .where(eq(tenant.id, tenantId));
  return updated;
}
