// Per-tenant branding: tenant.settings.brand recolors the app
// chrome so an operator always knows whose company they're looking at. The
// theme system is four CSS accent variables consumed app-wide; one validated
// accent hex derives all four. Values are validated hard here because they are
// interpolated into inline styles — a malformed value must die in parsing,
// never reach CSS.

export interface BrandConfig {
  name: string | null;
  logoUrl: string | null;
  logoUrlDark: string | null; // variant for the dark chrome (logos are imgs — they can't recolor with the theme)
  accent: string | null; // #rrggbb
  theme: "light" | null; // null = default dark cockpit
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const LOGO_URL = /^(data:image\/|https:\/\/)/;

export function parseBrandConfig(raw: unknown): BrandConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : null;
  const accent = typeof r.accent === "string" && HEX.test(r.accent.trim()) ? r.accent.trim() : null;
  const logo = (v: unknown) => (typeof v === "string" && LOGO_URL.test(v.trim()) ? v.trim() : null);
  const theme = r.theme === "light" ? "light" : null;
  return { name, logoUrl: logo(r.logoUrl), logoUrlDark: logo(r.logoUrlDark), accent, theme };
}

function mix(hex: string, target: number, ratio: number): string {
  // Mix each RGB channel toward `target` (255 = white, 0 = black) by `ratio`.
  const ch = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(v + (target - v) * ratio).toString(16).padStart(2, "0");
  };
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

/** Derive the app's four accent variables from one brand hex — mirrors the
 *  relationships of the default palette (bright ≈ +25% white, deep ≈ +12% black,
 *  006 = 6% alpha wash). */
export function brandAccentVars(accentHex: string): Record<string, string> {
  const hex = accentHex.toLowerCase();
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return {
    "--accent-gold": hex,
    "--accent-bright": mix(hex, 255, 0.25),
    "--accent-deep": mix(hex, 0, 0.12),
    "--accent-006": `rgba(${r}, ${g}, ${b}, 0.06)`,
  };
}

// Default accent for the light theme: the canvass app's copper (--acc).
const CANVASS_COPPER = "#b0722c";

/** Mode-explicit CSS variable record with plain kebab keys, usable both for
 *  SSR inline style and for client-side `style.setProperty` when the theme
 *  toggle applies a theme WITHOUT a server round trip. The light record also
 *  carries the wrapper's own paint ("background"/"color"/"color-scheme") —
 *  body sets those outside the override scope, so the wrapper must. */
export function brandThemeCssVars(brand: BrandConfig, mode: "light" | "dark"): Record<string, string> {
  const vars = brandThemeVars({ ...brand, theme: mode === "light" ? "light" : null }) ?? {};
  if (mode === "light") {
    return { ...vars, background: "var(--surface-app)", color: "var(--text-primary)", "color-scheme": "light" };
  }
  return vars;
}

/** Effective theme = per-browser cookie override, else the tenant default.
 *  Returns the BrandConfig["theme"] shape: "light" or null (= dark cockpit).
 *  Cookie values other than "light"/"dark" are ignored — the cookie is
 *  client-writable, so it gets the same hostile-input treatment as settings. */
export function resolveThemePreference(
  tenantDefault: BrandConfig["theme"],
  cookieValue: string | undefined,
): BrandConfig["theme"] {
  if (cookieValue === "dark") return null;
  if (cookieValue === "light") return "light";
  return tenantDefault;
}

/** Full CSS-variable override for a branded tenant.
 *
 *  - accent only → the four dark-chrome accent vars (unchanged behavior).
 *  - theme "light" → the canvass cream palette: every surface/text/border/status
 *    var the dark cockpit defines gets a light-legible counterpart, so the
 *    override is total — no dark token can bleed through on a light background.
 *
 *  On a light background accent emphasis INVERTS: hover/emphasis ("bright")
 *  must get darker to keep contrast, where the dark theme lightens it. */
export function brandThemeVars(brand: BrandConfig): Record<string, string> | undefined {
  if (brand.theme !== "light") {
    return brand.accent ? brandAccentVars(brand.accent) : undefined;
  }
  const hex = (brand.accent ?? CANVASS_COPPER).toLowerCase();
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const alpha = (a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;
  const inkShadow = "0 8px 20px rgba(31, 30, 27, 0.08)";
  return {
    // shadcn tokens
    "--background": "#f0eee5",
    "--foreground": "#1f1e1b",
    "--card": "#fcfbf7",
    "--card-foreground": "#1f1e1b",
    "--popover": "#fcfbf7",
    "--popover-foreground": "#1f1e1b",
    "--primary": hex,
    "--primary-foreground": "#fcfbf7",
    "--secondary": alpha(0.08),
    "--secondary-foreground": "#3a352c",
    "--muted": "rgba(31, 30, 27, 0.04)",
    "--muted-foreground": "#6e695f",
    "--accent": alpha(0.1),
    "--accent-foreground": "#1f1e1b",
    "--destructive": "#c0392b",
    "--destructive-foreground": "#fcfbf7",
    "--border": "#e5e1d4",
    "--input": "#dcd7c8",
    "--ring": hex,
    // cockpit surfaces + text
    "--surface-app": "radial-gradient(125% 95% at 50% -12%, #f7f5ec 0%, #f0eee5 55%, #e8e4d6 100%)",
    "--surface-panel": "#fcfbf7",
    "--border-panel": "#e5e1d4",
    "--text-primary": "#1f1e1b",
    "--text-body": "#35322b",
    "--text-muted": "#6e695f",
    "--text-faint": "#938d7b",
    // accent scale — emphasis darkens on light
    "--accent-gold": hex,
    "--accent-bright": mix(hex, 0, 0.12),
    "--accent-deep": mix(hex, 0, 0.24),
    "--accent-006": alpha(0.06),
    "--accent-010": alpha(0.1),
    "--accent-016": alpha(0.16),
    "--accent-030": alpha(0.3),
    "--accent-040": alpha(0.4),
    "--sage": "#6c7a45",
    // persona colors, darkened from the dark-chrome originals for cream legibility
    "--agent-sage": hex,
    "--agent-vera": "#6f7a4f",
    "--agent-milo": "#47807b",
    "--agent-scout": "#a05f3e",
    "--agent-raine": "#826277",
    "--agent-nova": "#a3685a",
    // status
    "--status-ok": "#3d7a44",
    "--status-skip": "#c07f16",
    "--status-error": "#c0392b",
    "--status-running": "#3d6b96",
    // glows: gold halos read as smudges on cream — use a soft ink drop shadow
    "--glow-accent": inkShadow,
    "--active-shadow": inkShadow,
  };
}
