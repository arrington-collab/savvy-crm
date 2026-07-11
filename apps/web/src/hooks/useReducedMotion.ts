"use client";
import { useEffect, useState } from "react";

/**
 * True when the user has asked the OS for reduced motion. Defaults to `false`
 * (assume motion) so server + first client render match; the effect corrects it
 * on mount and on live preference changes. Shared by the odometer (S2) and the
 * orb pulse (S5).
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: sync on mount for hydration safety
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
