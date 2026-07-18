import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { Sidebar } from "@/components/cockpit/Sidebar";
import { TopBar } from "@/components/cockpit/TopBar";
import { AskSage } from "@/components/cockpit/AskSage";
import { InflightProvider } from "@/components/inflight/InflightProvider";
import { needsOnboarding, brandThemeVars, resolveThemePreference } from "@savvy/core";
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
  // Per-tenant branding: validated brand settings override the theme's CSS
  // variables on this wrapper; custom properties inherit, so every component
  // below re-themes without knowing. body sets background and color OUTSIDE
  // this subtree, where the overrides aren't in scope — both resolve there to
  // the dark-chrome values and would leak in (background directly, color via
  // inheritance to any text without its own color utility). The light theme
  // therefore re-declares both here so they re-resolve against the overrides.
  const brand = await loadTenantBrand();
  // The savvy-theme cookie is a per-browser override of the tenant default, so
  // one operator can run dark while the tenant ships light (or vice versa).
  const themeCookie = (await cookies()).get("savvy-theme")?.value;
  const theme = resolveThemePreference(brand.theme, themeCookie);
  const themeVars = brandThemeVars({ ...brand, theme });
  const brandStyle =
    themeVars && theme === "light"
      ? {
          ...themeVars,
          background: "var(--surface-app)",
          color: "var(--text-primary)",
          colorScheme: "light" as const,
        }
      : themeVars;
  return (
    <InflightProvider>
      <div className="flex min-h-screen" style={brandStyle}>
        <Sidebar decisionCount={decisionCount} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            authEnabled={authEnabled}
            brandName={brand.name}
            // logos are imgs and can't recolor with the theme — dark chrome
            // prefers the dark variant when the tenant ships one
            brandLogoUrl={theme === "light" ? brand.logoUrl : (brand.logoUrlDark ?? brand.logoUrl)}
            theme={theme ?? "dark"}
          />
          <main className="flex-1 p-6">{children}</main>
        </div>
        <AskSage />
      </div>
    </InflightProvider>
  );
}
