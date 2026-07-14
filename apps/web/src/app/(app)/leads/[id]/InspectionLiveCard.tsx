"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { InspectionProgress } from "@savvy/db";
import { startLeadInspection, completeLeadInspection } from "./inspection-actions";

const POLL_MS = 5000;

const ZONE_KIND_ICON: Record<string, string> = {
  ground: "⌂", facet: "◱", valley: "▽", ridge: "△",
  penetrations: "◉", gutters: "▭", attic: "▲", other: "•",
};

/**
 * Live "Inspection in progress — N zones" card. Zones appear within seconds of
 * capture (BloomCam webhook → SiteSnap pipe → poll). Polls only while the
 * inspection is inside the capture/approval window; otherwise renders the
 * start affordance.
 */
export function InspectionLiveCard({ leadId, initial }: { leadId: string; initial: InspectionProgress | null }) {
  const [progress, setProgress] = useState<InspectionProgress | null>(initial);
  const [pending, startTransition] = useTransition();

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/inspections/progress?leadId=${encodeURIComponent(leadId)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { progress: InspectionProgress | null };
      setProgress(data.progress);
    } catch { /* transient poll failure — next tick retries */ }
  }, [leadId]);

  const live = progress?.status === "in_progress";
  useEffect(() => {
    if (!live) return;
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [live, poll]);

  if (!progress) {
    return (
      <Card className="p-4" data-section="inspection">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Roof Record</h3>
            <p className="text-xs" style={{ color: "var(--text-faint)" }}>
              No inspection yet — start capture in BloomCam, or start one here.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => startTransition(async () => { await startLeadInspection(leadId); await poll(); })}
            data-testid="start-inspection"
          >
            Start inspection
          </Button>
        </div>
      </Card>
    );
  }

  const zoneCount = progress.zones.length;
  return (
    <Card className="p-4" data-section="inspection" data-testid="inspection-live-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {live ? (
            <>
              <span className="relative mr-2 inline-flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Inspection in progress — {zoneCount} {zoneCount === 1 ? "zone" : "zones"}
            </>
          ) : (
            <>Inspection captured — awaiting inspector approval</>
          )}
        </h3>
        {live ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => startTransition(async () => { await completeLeadInspection(leadId, progress.inspectionId); await poll(); })}
            data-testid="complete-inspection"
          >
            Complete
          </Button>
        ) : null}
      </div>

      {zoneCount === 0 ? (
        <p className="mt-2 text-xs" style={{ color: "var(--text-faint)" }}>Waiting for the first zone — capturing…</p>
      ) : (
        <ul className="mt-3 space-y-1.5" data-testid="inspection-zones">
          {progress.zones.map((z) => (
            <li key={z.zoneKey} className="flex items-center justify-between text-sm" data-testid={`zone-${z.zoneKey}`}>
              <span className="flex items-center gap-2">
                <span aria-hidden style={{ color: "var(--text-faint)" }}>{ZONE_KIND_ICON[z.zoneKind] ?? "•"}</span>
                {z.zoneLabel}
              </span>
              <span className="text-xs" style={{ color: "var(--text-faint)" }}>
                {z.grade ? z.grade.toUpperCase() : `${z.photoCount} ${z.photoCount === 1 ? "photo" : "photos"}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
