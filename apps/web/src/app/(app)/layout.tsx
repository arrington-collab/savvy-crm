import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { Sidebar } from "@/components/cockpit/Sidebar";
import { TopBar } from "@/components/cockpit/TopBar";
import { AskSage } from "@/components/cockpit/AskSage";
import { InflightProvider } from "@/components/inflight/InflightProvider";
import { needsOnboarding, brandThemeCssVars, resolveThemePreference } from "@savvy/core";
import { getCurrentUser } from "@/lib/current-user";
import { getOnboardingStatus } from "@/lib/onboarding-queries";
import { loadTenantRollup } from "@/lib/scoreboard-queries";
import { loadTenantChrome } from "@/lib/brand-queries";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const authEnabled = process.env.TEST_MODE !== "1";
  if (authEnabled) {
    const { userId, orgId } = await auth();
    if (!userId) redirect("/sign-in");
    if (!orgId) redirect("/select-org");
  }
  // Everything below runs on EVERY navigation and is independent (all key off the
  // per-request-cached tenant), so load it in parallel instead of a sequential
  // waterfall. getCurrentUser lazily provisions tenant + user row; the onboarding
  // gate is checked after the batch resolves (redirect must run outside Promise.all).
  const [, status, rollup, chrome, cookieStore] = await Promise.all([
    authEnabled ? getCurrentUser() : Promise.resolve(null),
    authEnabled ? getOnboardingStatus() : Promise.resolve(null),
    loadTenantRollup().catch(() => null),
    loadTenantChrome(),
    cookies(),
  ]);
  if (status && needsOnboarding(status.state)) redirect("/onboarding");
  // Nav decision-count pill: the cheap nightly rollup's open-exception count.
  // The Today screen shows the precise live queue; this badge is at-a-glance.
  const decisionCount = rollup?.openExceptionCount ?? 0;
  // Per-tenant branding: validated brand settings override the theme's CSS
  // variables on this wrapper; custom properties inherit, so every component
  // below re-themes without knowing. body sets background and color OUTSIDE
  // this subtree, where the overrides aren't in scope — both resolve there to
  // the dark-chrome values and would leak in (background directly, color via
  // inheritance to any text without its own color utility). The light theme
  // therefore re-declares both here so they re-resolve against the overrides.
  const { brand, markets } = chrome;
  // The savvy-theme cookie is a per-browser override of the tenant default, so
  // one operator can run dark while the tenant ships light (or vice versa).
  const themeCookie = cookieStore.get("savvy-theme")?.value;
  const theme = resolveThemePreference(brand.theme, themeCookie) ?? "dark";
  // Both modes' variable records go to the TopBar so its toggle can restyle
  // #app-chrome instantly on the client — the cookie only has to be right for
  // the NEXT full render, so no router.refresh() (≈5s of auth + queries).
  const varsLight = brandThemeCssVars(brand, "light");
  const varsDark = brandThemeCssVars(brand, "dark");
  const ssrVars = theme === "light" ? varsLight : varsDark;
  const { "color-scheme": ssrScheme, ...ssrRest } = ssrVars;
  const brandStyle = Object.keys(ssrVars).length
    ? { ...ssrRest, ...(ssrScheme ? { colorScheme: ssrScheme as "light" } : {}) }
    : undefined;
  return (
    <InflightProvider>
      <div id="app-chrome" className="flex min-h-screen" style={brandStyle}>
        <Sidebar decisionCount={decisionCount} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            authEnabled={authEnabled}
            brandName={brand.name}
            // logos are imgs and can't recolor with the theme — the toggle
            // swaps between the two variants client-side
            brandLogoUrl={brand.logoUrl}
            brandLogoUrlDark={brand.logoUrlDark}
            theme={theme}
            themeVarsLight={varsLight}
            themeVarsDark={varsDark}
            markets={markets}
          />
          <main className="flex-1 p-6">{children}</main>
        </div>
        <AskSage />
      </div>
    </InflightProvider>
  );
}
