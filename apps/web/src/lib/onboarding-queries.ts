import "server-only";
import { adminDb, tenant, user, eq, and, isNull, count, isNotNull } from "@savvy/db";
import {
  parseOnboardingState,
  deriveOnboardingSteps,
  type OnboardingState,
  type OnboardingSteps,
} from "@savvy/core";
import { getTenantId } from "./tenant";

export interface OnboardingStatus {
  state: OnboardingState;
  steps: OnboardingSteps;
  tenantName: string;
}

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  const tenantId = await getTenantId();
  const [t] = await adminDb
    .select({
      name: tenant.name,
      revenueBand: tenant.revenueBand,
      settings: tenant.settings,
      stripeAccountId: tenant.stripeAccountId,
      qboConnectionId: tenant.qboConnectionId,
      companycamConnectionId: tenant.companycamConnectionId,
    })
    .from(tenant)
    .where(eq(tenant.id, tenantId));

  // Count active, Clerk-backed users (excludes PIN crew + deactivated).
  const countRows = await adminDb
    .select({ value: count() })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), isNotNull(user.clerkUserId), isNull(user.deactivatedAt)));
  const activeUserCount = countRows[0]?.value ?? 0;

  const state = parseOnboardingState((t?.settings as Record<string, unknown> | undefined)?.onboarding);
  const steps = deriveOnboardingSteps({
    requiredCompletedAt: state.requiredCompletedAt,
    revenueBand: t?.revenueBand ?? null,
    activeUserCount: Number(activeUserCount),
    connections: {
      stripe: !!t?.stripeAccountId,
      qbo: !!t?.qboConnectionId,
      companycam: !!t?.companycamConnectionId,
    },
  });
  return { state, steps, tenantName: t?.name ?? "" };
}
