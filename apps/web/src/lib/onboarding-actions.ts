"use server";
import { revalidatePath } from "next/cache";
import {
  setOnboardingRequiredComplete,
  setOnboardingProfile,
  dismissOnboarding,
} from "@savvy/db";
import { BILLING_BANDS, parseFinanceConfig } from "@savvy/core";
import { getTenantId } from "./tenant";
import { getOnboardingStatus } from "./onboarding-queries";
import { canManageSettingsNow } from "./authz";

type Result = { ok: true } | { error: string };

export async function completeWelcome(companyName: string): Promise<Result> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  const name = companyName.trim();
  if (!name) return { error: "company name required" };
  const tenantId = await getTenantId();
  await setOnboardingRequiredComplete({ tenantId, name });
  revalidatePath("/onboarding");
  revalidatePath("/today");
  return { ok: true };
}

export async function saveProfile(input: { revenueBand: string; timezone: string }): Promise<Result> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  if (!BILLING_BANDS.some((b) => b.key === input.revenueBand)) return { error: "invalid band" };
  // parseFinanceConfig validates the IANA timezone (throws on bad zone).
  let timezone: string;
  try {
    timezone = parseFinanceConfig({ timezone: input.timezone }).timezone;
  } catch {
    return { error: "invalid timezone" };
  }
  const tenantId = await getTenantId();
  await setOnboardingProfile({ tenantId, revenueBand: input.revenueBand, timezone });
  revalidatePath("/onboarding");
  revalidatePath("/today");
  return { ok: true };
}

// "Skip for now" from the wizard. This IS the definition of skip: mark required
// onboarding complete (via the existing lifecycle writer, preserving the tenant's
// current name) so the (app) layout gate stops redirecting to /onboarding, and let
// the optional steps nag later via the Today onboarding card. Fixes the 2026-07-06
// lockout loop where skip navigated away without ever writing requiredCompletedAt.
export async function skipOnboarding(): Promise<Result> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  const { tenantName } = await getOnboardingStatus();
  await setOnboardingRequiredComplete({ tenantId, name: tenantName });
  revalidatePath("/onboarding");
  revalidatePath("/today");
  return { ok: true };
}

export async function dismissChecklist(): Promise<Result> {
  if (!(await canManageSettingsNow())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  await dismissOnboarding({ tenantId });
  revalidatePath("/today");
  return { ok: true };
}
