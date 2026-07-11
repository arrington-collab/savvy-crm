"use client";
import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SHOWCASE } from "@savvy/core";
import type { FeedRow } from "@/lib/command-center-queries";
import { ActivityRow } from "./ActivityRow";

export function ActivityFeed({ initial }: { initial: FeedRow[] }) {
  const [rows, setRows] = useState<FeedRow[]>(initial);
  const [live, setLive] = useState(true);
  const params = useSearchParams();
  const router = useRouter();

  const refresh = useCallback(async () => {
    const qs = new URLSearchParams();
    for (const k of ["agent", "status", "job"]) {
      const v = params.get(k);
      if (v) qs.set(k, v);
    }
    const res = await fetch(`/api/activity?${qs.toString()}`, { cache: "no-store" });
    if (res.ok) {
      setRows((await res.json()).rows);
      setLive(true);
    } else {
      setLive(false);
    }
  }, [params]);

  useEffect(() => {
    const id = setInterval(refresh, SHOWCASE.POLL_SECONDS * 1000);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: re-fetch when filters (URL params) change
    refresh();
  }, [refresh]);

  const setFilter = (k: string, v: string | null) => {
    const qs = new URLSearchParams(params.toString());
    if (v) qs.set(k, v);
    else qs.delete(k);
    router.replace(`/activity?${qs.toString()}`);
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span
          className="h-2 w-2 rounded-full anim-pulse"
          style={{ background: live ? "var(--status-ok)" : "var(--text-faint)" }}
        />
        <span style={{ color: "var(--text-muted)" }}>{live ? "live" : "reconnecting"}</span>
        <button data-testid="filter-status-error" onClick={() => setFilter("status", "error")} className="ml-4 underline">
          errors only
        </button>
        <button onClick={() => setFilter("status", null)} className="underline">
          all
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-faint)" }}>No activity yet.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <ActivityRow key={r.id} r={r} />
          ))}
        </ul>
      )}
    </div>
  );
}
