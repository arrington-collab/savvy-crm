"use client";
import { useEffect, useState } from "react";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";

export function TopBar({
  authEnabled,
  brandName,
  brandLogoUrl,
  brandLogoUrlDark,
  theme = "dark",
  themeVarsLight,
  themeVarsDark,
}: {
  authEnabled: boolean;
  brandName?: string | null;
  brandLogoUrl?: string | null;
  brandLogoUrlDark?: string | null;
  theme?: "light" | "dark";
  themeVarsLight?: Record<string, string>;
  themeVarsDark?: Record<string, string>;
}) {
  const [time, setTime] = useState("");
  // The toggle restyles #app-chrome directly — instant, no server round trip.
  // The cookie only matters for the NEXT full render (SSR picks the theme from
  // it), so we never router.refresh() here; that cost ~5s of auth + queries.
  // React won't fight the DOM mutation: the layout is a server component whose
  // style prop is only reapplied on a navigation, by which point the cookie
  // makes SSR agree with what we set here.
  const [mode, setMode] = useState<"light" | "dark">(theme);
  const toggleTheme = () => {
    const next = mode === "light" ? "dark" : "light";
    const el = document.getElementById("app-chrome");
    if (el) {
      const union = { ...(themeVarsDark ?? {}), ...(themeVarsLight ?? {}) };
      for (const key of Object.keys(union)) el.style.removeProperty(key);
      const target = (next === "light" ? themeVarsLight : themeVarsDark) ?? {};
      for (const [key, value] of Object.entries(target)) el.style.setProperty(key, value);
    }
    document.cookie = `savvy-theme=${next}; path=/; max-age=31536000; samesite=lax`;
    setMode(next);
  };
  const logoSrc = mode === "light" ? brandLogoUrl : (brandLogoUrlDark ?? brandLogoUrl);
  useEffect(() => {
    const tick = () =>
      setTime(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header
      className="flex h-14 shrink-0 items-center justify-between px-6"
      style={{ borderBottom: "1px solid var(--border-panel)" }}
    >
      <div className="flex items-center gap-3">
        {logoSrc ? (
          // Per-tenant logo (settings.brand) — the operator always knows whose
          // company they're in. eslint-disable: data-URL/https logos aren't
          // next/image candidates.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoSrc} alt={brandName ?? "Company logo"} className="h-8 w-auto" />
        ) : (
          <span className="font-semibold tracking-tight text-accent-gold">{brandName ?? "Savvy"}</span>
        )}
        <span
          className="mono inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px]"
          style={{ background: "var(--accent-006)", border: "1px solid var(--border-panel)", color: "var(--text-muted)" }}
        >
          <span className="anim-pulse h-1.5 w-1.5 rounded-full" style={{ background: "var(--sage)" }} />
          SAGE · ONLINE
        </span>
      </div>
      <div className="flex items-center gap-4">
        <span className="mono text-[12px]" style={{ color: "var(--text-muted)" }} suppressHydrationWarning>
          {time}
        </span>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}
          title={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[15px]"
          style={{ border: "1px solid var(--border-panel)", color: "var(--text-muted)" }}
        >
          {mode === "light" ? "☾" : "☀"}
        </button>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("ask-sage:open"))}
          className="mono inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px]"
          style={{
            background:
              "linear-gradient(var(--popover), var(--popover)) padding-box, linear-gradient(120deg, var(--accent-bright), var(--accent-deep)) border-box",
            border: "1px solid transparent",
            color: "var(--text-primary)",
          }}
        >
          <span className="text-accent-gold">✦</span> Ask Sage
          <kbd className="text-[10px]" style={{ color: "var(--text-faint)" }}>⌘K</kbd>
        </button>
        {authEnabled ? (
          <>
            <OrganizationSwitcher hidePersonal afterCreateOrganizationUrl="/dashboard" afterSelectOrganizationUrl="/dashboard" />
            <UserButton />
          </>
        ) : null}
      </div>
    </header>
  );
}
