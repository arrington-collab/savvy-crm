"use server";
import { revalidatePath } from "next/cache";
import {
  setOnboardingRequiredComplete,
  setOnboardingProfile,
  dismissOnboarding,
} from "@savvy/db";
import { BILLING_BANDS, parseFinanceConfig } from "@savvy/core";
import { getTenantId } from "./tenant";
import { isOrgAdmin } from "./authz";

type Result = { ok: true } | { error: string };

export async function completeWelcome(companyName: string): Promise<Result> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  const name = companyName.trim();
  if (!name) return { error: "company name required" };
  const tenantId = await getTenantId();
  await setOnboardingRequiredComplete({ tenantId, name });
  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function saveProfile(input: { revenueBand: string; timezone: string }): Promise<Result> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
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
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function dismissChecklist(): Promise<Result> {
  if (!(await isOrgAdmin())) return { error: "forbidden" };
  const tenantId = await getTenantId();
  await dismissOnboarding({ tenantId });
  revalidatePath("/dashboard");
  return { ok: true };
}
