import { eq } from "drizzle-orm";
import { tenant } from "../schema/index";
import { adminDb } from "../admin-client";

// Tenant is the RLS isolation root — savvy_app lacks UPDATE on it, so all tenant
// writes go through adminDb. We read-modify-write tenant.settings (the same
// pattern as settings-actions.ts) so sibling keys (scheduling/finance/esign)
// are preserved. Each helper merges only its own nested key.

async function readSettings(tenantId: string): Promise<Record<string, unknown>> {
  const [t] = await adminDb
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return (t?.settings as Record<string, unknown>) ?? {};
}

export async function setOnboardingRequiredComplete(
  input: { tenantId: string; name: string },
): Promise<void> {
  const settings = await readSettings(input.tenantId);
  const onboarding = {
    ...((settings.onboarding as object) ?? {}),
    requiredCompletedAt: new Date().toISOString(),
  };
  await adminDb
    .update(tenant)
    .set({ name: input.name, settings: { ...settings, onboarding } })
    .where(eq(tenant.id, input.tenantId));
}

export async function setOnboardingProfile(
  input: { tenantId: string; revenueBand: string; timezone: string },
): Promise<void> {
  const settings = await readSettings(input.tenantId);
  const finance = { ...((settings.finance as object) ?? {}), timezone: input.timezone };
  await adminDb
    .update(tenant)
    .set({ revenueBand: input.revenueBand, settings: { ...settings, finance } })
    .where(eq(tenant.id, input.tenantId));
}

export async function dismissOnboarding(input: { tenantId: string }): Promise<void> {
  const settings = await readSettings(input.tenantId);
  const onboarding = { ...((settings.onboarding as object) ?? {}), dismissed: true };
  await adminDb
    .update(tenant)
    .set({ settings: { ...settings, onboarding } })
    .where(eq(tenant.id, input.tenantId));
}
