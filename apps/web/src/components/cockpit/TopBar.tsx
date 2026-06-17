"use client";
import { useEffect, useState } from "react";

export function TopBar() {
  const [time, setTime] = useState("");
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
        <span className="font-semibold tracking-tight text-accent-gold">Savvy</span>
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
      </div>
    </header>
  );
}
