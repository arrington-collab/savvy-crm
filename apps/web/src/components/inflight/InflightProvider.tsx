"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { SHOWCASE, type InflightMap } from "@savvy/core";

const Ctx = createContext<InflightMap>({ jobs: {}, leads: {} });

export function useInflight(kind: "job" | "lead", id: string) {
  const map = useContext(Ctx);
  return (kind === "job" ? map.jobs : map.leads)[id] ?? null;
}

export function InflightProvider({ children }: { children: React.ReactNode }) {
  const [map, setMap] = useState<InflightMap>({ jobs: {}, leads: {} });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/inflight", { cache: "no-store" });
        if (alive && res.ok) setMap(await res.json());
      } catch {
        /* keep last known map */
      }
    };
    tick();
    const h = setInterval(tick, SHOWCASE.POLL_SECONDS * 1000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
}
