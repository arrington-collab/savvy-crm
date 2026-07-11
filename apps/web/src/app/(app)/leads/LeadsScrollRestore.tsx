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
    let restoreRaf = 0;
    let restoring = saved > 0;
    if (Number.isFinite(saved) && saved > 0) {
      // Re-apply the saved offset every frame until it lands, for up to ~3s. This
      // wins the race with the router's scroll-to-top on navigation AND waits out
      // the streamed (server-rendered) list: while the page is still too short the
      // scroll clamps below `saved`, so we simply keep trying until it has laid out
      // tall enough — then stop. Time-budgeted so a genuinely short list gives up.
      const deadline = Date.now() + 3000;
      const reapply = () => {
        window.scrollTo(0, saved);
        if (Math.abs(window.scrollY - saved) > 4 && Date.now() < deadline) {
          restoreRaf = requestAnimationFrame(reapply);
        } else {
          restoring = false;
        }
      };
      restoreRaf = requestAnimationFrame(reapply);
    }
    let saveRaf = 0;
    const onScroll = () => {
      if (restoring || saveRaf) return; // don't overwrite the target mid-restore
      saveRaf = requestAnimationFrame(() => {
        saveRaf = 0;
        sessionStorage.setItem(KEY, String(window.scrollY));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (saveRaf) cancelAnimationFrame(saveRaf);
      if (restoreRaf) cancelAnimationFrame(restoreRaf);
    };
  }, []);
  return null;
}
