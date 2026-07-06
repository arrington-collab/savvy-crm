import { z } from "./schemas";

const onboardingStateSchema = z.object({
  requiredCompletedAt: z.string().nullable().default(null),
  dismissed: z.boolean().default(false),
});

export type OnboardingState = z.infer<typeof onboardingStateSchema>;

/** Parse tenant.settings.onboarding (or anything) into a complete OnboardingState. */
export function parseOnboardingState(raw: unknown): OnboardingState {
  return onboardingStateSchema.parse(raw ?? {});
}

export interface OnboardingStepsInput {
  requiredCompletedAt: string | null;
  revenueBand: string | null;
  activeUserCount: number;
  connections: { stripe: boolean; qbo: boolean; companycam: boolean };
}

export interface OnboardingSteps {
  company: boolean;
  band: boolean;
  team: boolean;
  integrations: boolean;
}

/** Derive checklist truth from real tenant data (NOT stored flags). */
export function deriveOnboardingSteps(input: OnboardingStepsInput): OnboardingSteps {
  return {
    company: input.requiredCompletedAt != null,
    band: input.revenueBand != null,
    team: input.activeUserCount > 1,
    integrations:
      input.connections.stripe || input.connections.qbo || input.connections.companycam,
  };
}

export function isOnboardingComplete(steps: OnboardingSteps): boolean {
  return steps.company && steps.band && steps.team && steps.integrations;
}

/**
 * The (app) layout onboarding-gate decision. A tenant is locked to /onboarding
 * until required onboarding is marked complete (settings.onboarding.requiredCompletedAt).
 * This is the exact predicate behind the 2026-07-06 P0 lockout: pre-existing tenants
 * with real jobs/leads had a null flag and were redirected on EVERY route. Lives here
 * in core (pure, CI-gated) rather than apps/web, whose unit tests the vitest workspace
 * does not run. The 0059 backfill + the wizard skip fix set the flag; the
 * onboarding.no_lockout sweep invariant guards against a regression.
 */
export function needsOnboarding(state: Pick<OnboardingState, "requiredCompletedAt">): boolean {
  return state.requiredCompletedAt === null;
}
