"use client";
import { useEffect } from "react";
import type { ActivityRow } from "@/lib/command-center-queries";

type Cov = { agent: string; label: string; total: number };

/** Registers telemetry-derived Ask Sage answers (renders nothing). The single
    AskSage palette in the layout listens for "ask-sage:set" and merges these
    ahead of its static defaults. */
export function CommandCenterAskSage({
  activity,
  coverage,
  spendCents,
}: {
  activity: ActivityRow[];
  coverage: Cov[];
  spendCents: number;
}) {
  useEffect(() => {
    const errors = activity.filter((r) => r.status === "error");
    const skips = activity.filter((r) => r.status === "skipped");
    const idle = coverage.filter((c) => c.total === 0).map((c) => c.label);
    const qs = [
      {
        q: "What errored today?",
        answer: errors.length
          ? `${errors.length} error(s): ${errors.map((e) => `${e.taskKey ?? "action"}${e.error ? ` — ${e.error}` : ""}`).join("; ")}.`
          : "Nothing errored — the board is clean.",
        actions: [{ label: "Open Command Center", href: "/command-center" }],
      },
      {
        q: "Why is finance skipping?",
        answer: skips.length
          ? `${skips.length} skip(s): ${[...new Set(skips.map((s) => s.error ?? "no reason"))].join(", ")}. A skip means the work wasn't needed (e.g. Stripe not connected) — nothing's lost.`
          : "Finance isn't skipping anything right now.",
        actions: [{ label: "Payments settings", href: "/settings/payments" }],
      },
      {
        q: "Who's idle?",
        answer: idle.length ? `No runs recently from: ${idle.join(", ")}.` : "Everyone's run recently — no idle agents.",
        actions: [{ label: "Crew health", href: "/dashboard" }],
      },
      { q: "What's my AI spend?", answer: `$${(spendCents / 100).toFixed(2)} across the last 30 days.` },
    ];
    window.dispatchEvent(new CustomEvent("ask-sage:set", { detail: qs }));
    return () => { window.dispatchEvent(new CustomEvent("ask-sage:set", { detail: [] })); };
  }, [activity, coverage, spendCents]);
  return null;
}
