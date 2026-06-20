import { getOnboardingStatus } from "@/lib/onboarding-queries";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { BILLING_BANDS } from "@savvy/core";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const { steps, tenantName } = await getOnboardingStatus();
  const bands = BILLING_BANDS.map((b) => ({ key: b.key, name: b.name, monthlyPriceCents: b.monthlyPriceCents }));
  return <OnboardingWizard tenantName={tenantName} steps={steps} bands={bands} />;
}
