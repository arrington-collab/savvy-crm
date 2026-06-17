"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PERSONAS } from "@/lib/agents";

type SageQuestion = { q: string; answer: string; actions?: { label: string; href: string }[] };

// App-wide ops questions. Answers are in SAGE's voice; actions route to real
// pages. TODO: compute answers from live telemetry (needs page-level data).
const QUESTIONS: SageQuestion[] = [
  {
    q: "What errored today?",
    answer:
      "Nothing's on fire — I'd flag any error the second it lands. The live log on the Command Center is the source of truth.",
    actions: [{ label: "Open Command Center", href: "/command-center" }],
  },
  {
    q: "Why is finance skipping?",
    answer:
      "VERA skips an auto-send when Stripe isn't connected yet — the supplemental invoice stays drafted, so nothing's lost. Connect payments and she'll send on approval.",
    actions: [{ label: "Payments settings", href: "/settings/payments" }],
  },
  {
    q: "Who's idle?",
    answer:
      "SCOUT (Claims) is deferred by design. The rest run on events — quiet means there's no work waiting, not a problem. Crew health has the details.",
    actions: [{ label: "Crew health", href: "/dashboard" }],
  },
  {
    q: "Show me the pipeline.",
    answer: "Here's the board — I'll point out anything that's aging.",
    actions: [{ label: "Open Jobs", href: "/jobs" }],
  },
];

export function AskSage() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<SageQuestion | null>(null);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const sage = PERSONAS.SAGE;

  useEffect(() => {
    const openPalette = () => { setSel(null); setQuery(""); setOpen(true); };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => {
          if (!o) { setSel(null); setQuery(""); }
          return !o;
        });
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("ask-sage:open", openPalette);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("ask-sage:open", openPalette);
    };
  }, []);

  // Focus the input when the palette opens (no setState here).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const filtered = useMemo(
    () => QUESTIONS.filter((x) => x.q.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]"
      style={{ background: "rgba(8,6,3,0.6)", backdropFilter: "blur(6px)" }}
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--popover)",
          border: "1px solid var(--border-panel)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.6), var(--glow-accent)",
        }}
      >
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: "1px solid var(--border-panel)" }}>
          <span className="text-lg text-accent-gold">✦</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSel(null); }}
            placeholder="Ask Sage…"
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: "var(--text-primary)" }}
          />
          <span className="anim-blink h-4 w-px" style={{ background: "var(--accent-bright)" }} />
        </div>

        {!sel ? (
          <div className="p-2">
            <div className="eyebrow px-2 py-1.5">Try asking</div>
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm" style={{ color: "var(--text-faint)" }}>
                I don&apos;t have a canned answer for that yet — try one below.
              </div>
            ) : (
              filtered.map((qq) => (
                <button
                  key={qq.q}
                  onClick={() => setSel(qq)}
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--accent-006)]"
                  style={{ color: "var(--text-body)" }}
                >
                  {qq.q}
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="p-4">
            <div className="flex items-start gap-3">
              <span
                className="mono inline-flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold"
                style={{
                  color: sage.colorToken,
                  border: `1px solid color-mix(in srgb, ${sage.colorToken} 55%, transparent)`,
                  background: `color-mix(in srgb, ${sage.colorToken} 14%, transparent)`,
                }}
              >
                {sage.initials}
              </span>
              <div className="min-w-0">
                <div className="eyebrow" style={{ color: sage.colorToken }}>SAGE</div>
                <p className="mt-0.5 text-sm" style={{ color: "var(--text-body)" }}>{sel.answer}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(sel.actions ?? []).map((a) => (
                    <button
                      key={a.label}
                      onClick={() => { router.push(a.href); setOpen(false); }}
                      className="mono rounded-md px-3 py-1.5 text-xs"
                      style={{ background: "var(--accent-010)", border: "1px solid var(--accent-040)", color: "var(--text-primary)" }}
                    >
                      {a.label}
                    </button>
                  ))}
                  <button
                    onClick={() => setSel(null)}
                    className="mono rounded-md px-3 py-1.5 text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    ← back
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
