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
