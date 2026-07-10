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
    if (Number.isFinite(saved) && saved > 0) {
      requestAnimationFrame(() => window.scrollTo(0, saved));
    }
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        sessionStorage.setItem(KEY, String(window.scrollY));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return null;
}
