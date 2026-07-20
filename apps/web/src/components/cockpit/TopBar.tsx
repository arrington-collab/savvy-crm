"use client";
import { useEffect, useState } from "react";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import type { Market } from "@savvy/core";

export function TopBar({
  authEnabled,
  brandName,
  brandLogoUrl,
  brandLogoUrlDark,
  theme = "dark",
  themeVarsLight,
  themeVarsDark,
  markets = [],
}: {
  authEnabled: boolean;
  brandName?: string | null;
  brandLogoUrl?: string | null;
  brandLogoUrlDark?: string | null;
  theme?: "light" | "dark";
  themeVarsLight?: Record<string, string>;
  themeVarsDark?: Record<string, string>;
  markets?: Market[];
}) {
  const [time, setTime] = useState("");
  // Market clocks: one local time per market the tenant operates in (settings.
  // markets, validated in core). No markets configured → browser-local time,
  // seconds included (the original clock). With markets, seconds are dropped —
  // two-plus ticking second counters read as noise.
  const [marketTimes, setMarketTimes] = useState<string[]>([]);
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
    const tick = () => {
      if (markets.length) {
        setMarketTimes(
          markets.map((m) =>
            new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: m.timezone }),
          ),
        );
      } else {
        setTime(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // markets come from server settings — stable per render; length/content only
    // change with a full navigation, which remounts anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        {markets.length ? (
          <span className="mono hidden items-center gap-3 text-[12px] md:flex" suppressHydrationWarning>
            {markets.map((m, i) => (
              <span key={m.label} className="flex items-center gap-1.5">
                <span style={{ color: "var(--text-faint)" }}>{m.label}</span>
                <span style={{ color: "var(--text-muted)" }}>{marketTimes[i] ?? ""}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="mono text-[12px]" style={{ color: "var(--text-muted)" }} suppressHydrationWarning>
            {time}
          </span>
        )}
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
