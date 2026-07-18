import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Sidebar } from "@/components/cockpit/Sidebar";
import { TopBar } from "@/components/cockpit/TopBar";
import { AskSage } from "@/components/cockpit/AskSage";
import { InflightProvider } from "@/components/inflight/InflightProvider";
import { needsOnboarding, brandAccentVars } from "@savvy/core";
import { getCurrentUser } from "@/lib/current-user";
import { getOnboardingStatus } from "@/lib/onboarding-queries";
import { loadTenantRollup } from "@/lib/scoreboard-queries";
import { loadTenantBrand } from "@/lib/brand-queries";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const authEnabled = process.env.TEST_MODE !== "1";
  if (authEnabled) {
    const { userId, orgId } = await auth();
    if (!userId) redirect("/sign-in");
    if (!orgId) redirect("/select-org");
    await getCurrentUser(); // lazily provision tenant + this user's row
    const status = await getOnboardingStatus();
    if (needsOnboarding(status.state)) redirect("/onboarding");
  }
  // Nav decision-count pill: the cheap nightly rollup's open-exception count.
  // The Today screen shows the precise live queue; this badge is at-a-glance.
  const rollup = await loadTenantRollup().catch(() => null);
  const decisionCount = rollup?.openExceptionCount ?? 0;
  // Per-tenant branding: one validated accent hex retints the whole chrome by
  // overriding the accent variables at the root (43 components read them).
  const brand = await loadTenantBrand();
  const brandVars = brand.accent ? brandAccentVars(brand.accent) : undefined;
  return (
    <InflightProvider>
      <div className="flex min-h-screen" style={brandVars}>
        <Sidebar decisionCount={decisionCount} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar authEnabled={authEnabled} brandName={brand.name} brandLogoUrl={brand.logoUrl} />
          <main className="flex-1 p-6">{children}</main>
        </div>
        <AskSage />
      </div>
    </InflightProvider>
  );
}
