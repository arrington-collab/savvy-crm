import type { Persona } from "@/lib/agents";

/** Round persona avatar — color + glow come from the persona's CSS color token. */
export function AgentAvatar({
  persona,
  size = "md",
  dimmed = false,
}: {
  persona: Persona;
  size?: "sm" | "md";
  dimmed?: boolean;
}) {
  const px = size === "sm" ? 24 : 32;
  const c = persona.colorToken;
  return (
    <span
      className="mono inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: px,
        height: px,
        fontSize: size === "sm" ? 9 : 11,
        color: c,
        border: `1px solid color-mix(in srgb, ${c} 55%, transparent)`,
        background: `color-mix(in srgb, ${c} 14%, transparent)`,
        boxShadow: dimmed ? "none" : `0 0 14px color-mix(in srgb, ${c} 35%, transparent)`,
        opacity: dimmed ? 0.45 : 1,
      }}
      title={`${persona.name} · ${persona.role}`}
    >
      {persona.initials}
    </span>
  );
}
