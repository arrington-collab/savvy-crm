"use client";
import { useEffect } from "react";

const KEY = "leads:list:scrollY";

/**
 * Slice 4: remembers the leads-list scroll position so the tile's "← Back to Leads"
 * button (a forward <Link> navigation, which doesn't get browser scroll restoration)
 * returns the rep to where they were. Filters are preserved separately via the row's
 * `?from` param; this handles scroll only.
 */
export function LeadsScrollRestore() {
  useEffect(() => {
    const saved = Number(sessionStorage.getItem(KEY) ?? "");
    let restoring = Number.isFinite(saved) && saved > 0;
    let timer: ReturnType<typeof setInterval> | undefined;

    if (restoring) {
      // Poll-restore for up to ~3s. Re-applying on an interval (not a single frame)
      // both waits out the streamed server-rendered list — while it's still too short
      // the scroll clamps below `saved`, so we keep trying — and outlasts the App
      // Router's scroll-to-top on navigation (it resets once; we re-apply after).
      // Only stop once the offset has held for several consecutive ticks, so a late
      // reset can't win the final frame.
      const deadline = Date.now() + 3000;
      let held = 0;
      timer = setInterval(() => {
        window.scrollTo(0, saved);
        held = Math.abs(window.scrollY - saved) <= 4 ? held + 1 : 0;
        if (held >= 4 || Date.now() >= deadline) {
          restoring = false;
          if (timer) clearInterval(timer);
        }
      }, 50);
    }

    let saveRaf = 0;
    const onScroll = () => {
      if (restoring || saveRaf) return; // don't clobber the saved target mid-restore
      saveRaf = requestAnimationFrame(() => {
        saveRaf = 0;
        sessionStorage.setItem(KEY, String(window.scrollY));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (saveRaf) cancelAnimationFrame(saveRaf);
      if (timer) clearInterval(timer);
    };
  }, []);
  return null;
}
