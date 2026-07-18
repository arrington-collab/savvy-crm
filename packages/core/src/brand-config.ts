// Per-tenant branding (Alta cutover): tenant.settings.brand recolors the app
// chrome so an operator always knows whose company they're looking at. The
// theme system is four CSS accent variables consumed app-wide; one validated
// accent hex derives all four. Values are validated hard here because they are
// interpolated into inline styles — a malformed value must die in parsing,
// never reach CSS.

export interface BrandConfig {
  name: string | null;
  logoUrl: string | null;
  accent: string | null; // #rrggbb
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function parseBrandConfig(raw: unknown): BrandConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : null;
  const accent = typeof r.accent === "string" && HEX.test(r.accent.trim()) ? r.accent.trim() : null;
  const logoRaw = typeof r.logoUrl === "string" ? r.logoUrl.trim() : "";
  const logoUrl = /^(data:image\/|https:\/\/)/.test(logoRaw) ? logoRaw : null;
  return { name, logoUrl, accent };
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
