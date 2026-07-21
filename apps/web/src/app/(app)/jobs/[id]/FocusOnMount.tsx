"use client";

import { useEffect } from "react";

// A Today decision-card deep-links to /jobs/{id}?focus=<target>. On arrival we
// scroll the matching surface into view and briefly ring it so the operator's
// eye lands on the exact thing that needs work — not the top of the page.
const TARGET_ELEMENT: Record<string, string> = {
  tasks: "focus-tabs",
  docs: "focus-tabs",
  materials: "focus-materials",
  margin: "focus-margin",
};

export function FocusOnMount({ focus }: { focus?: string }) {
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(TARGET_ELEMENT[focus] ?? `focus-${focus}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Inline style (not a Tailwind class) so there's nothing to purge; restores
    // whatever was there before after the ring fades.
    const prev = el.style.boxShadow;
    el.style.transition = "box-shadow 0.3s ease";
    el.style.boxShadow = "0 0 0 2px var(--accent-gold)";
    const t = setTimeout(() => { el.style.boxShadow = prev; }, 2200);
    return () => clearTimeout(t);
  }, [focus]);
  return null;
}
