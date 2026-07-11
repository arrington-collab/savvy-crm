"use client";

export function TypingDots({ verb, agent }: { verb: string; agent: string }) {
  return (
    <span
      data-testid="inflight-dots"
      className="inline-flex items-center gap-1.5 text-[11px]"
      style={{ color: "var(--status-running, var(--accent-bright))" }}
      title={`${agent} · ${verb}`}
    >
      <span className="inline-flex gap-0.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1 w-1 rounded-full anim-pulse"
            style={{ background: "currentColor", animationDelay: `${i * 200}ms` }}
          />
        ))}
      </span>
      <span className="truncate">{verb}</span>
    </span>
  );
}
