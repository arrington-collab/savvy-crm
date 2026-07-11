"use client";
import { useEffect } from "react";

const KEY = "leads:list:scrollY";

/**
 * Slice 4: remembers the leads-list scroll position so the tile's "← Back to Leads"
 * button (a forward <Link> navigation, which doesn't get browser scroll restoration)
 * returns the rep to where they were. Filters are preserved separately via the row's
 * `?from` param; this handles scroll only.
 *
 * The position is captured on the row click (capture phase) — i.e. the instant BEFORE
 * the router navigates and scrolls to top. Saving on scroll/unmount instead reads 0,
 * because the App Router resets window scroll before the list unmounts.
 */
export function LeadsScrollRestore() {
  useEffect(() => {
    // Restore: the leads list was returned to. Re-apply the saved offset on a 50ms
    // interval for up to ~3s — this waits out the streamed server-rendered list (a
    // still-short page clamps the scroll below target, so we keep trying) and outlasts
    // the router's one-time scroll-to-top. Stop once it has held for a few ticks.
    const saved = Number(sessionStorage.getItem(KEY) ?? "");
    let timer: ReturnType<typeof setInterval> | undefined;
    if (Number.isFinite(saved) && saved > 0) {
      const deadline = Date.now() + 3000;
      let held = 0;
      timer = setInterval(() => {
        window.scrollTo(0, saved);
        held = Math.abs(window.scrollY - saved) <= 4 ? held + 1 : 0;
        if (held >= 4 || Date.now() >= deadline) {
          if (timer) clearInterval(timer);
          timer = undefined;
        }
      }, 50);
    }

    // Save: capture scroll when a lead row is clicked, before the navigation resets it.
    const onDocClickCapture = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('[data-testid="lead-row"]')) {
        sessionStorage.setItem(KEY, String(window.scrollY));
      }
    };
    document.addEventListener("click", onDocClickCapture, true);
    return () => {
      document.removeEventListener("click", onDocClickCapture, true);
      if (timer) clearInterval(timer);
    };
  }, []);
  return null;
}
