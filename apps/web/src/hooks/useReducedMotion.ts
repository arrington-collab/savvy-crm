"use client";
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Client snapshot: the live OS preference. */
function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

/** Server snapshot: assume motion. The odometer renders its final numbers on the
 *  server regardless, so this only governs whether the client animates. */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * True when the user has asked the OS for reduced motion. Uses useSyncExternalStore
 * so the value is correct and tear-free during hydration — resolved before the
 * browser paints, so a reduced-motion consumer never shows a frame of movement.
 * Shared by the odometer (S2) and the orb pulse (S5).
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
