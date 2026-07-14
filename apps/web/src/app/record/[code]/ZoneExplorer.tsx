"use client";

import { useState } from "react";
import type { RecordPageZone } from "@savvy/db";
import { GRADE_FILL } from "./RecordHero";

const GRADE_COPY: Record<string, { label: string; chip: string }> = {
  good: { label: "Good", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  monitor: { label: "Monitor", chip: "bg-amber-50 text-amber-700 ring-amber-200" },
  action: { label: "Needs attention", chip: "bg-rose-50 text-rose-700 ring-rose-200" },
};

/**
 * Zone explorer: tap a zone → its grade, findings in plain English (what it is /
 * if ignored / timeframe), and the photos AT that zone. Never a flat photo dump.
 */
export function ZoneExplorer({ zones, code }: { zones: RecordPageZone[]; code: string }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <ul className="space-y-2" data-testid="zone-explorer">
      {zones.map((z) => {
        const isOpen = open === z.zoneKey;
        const grade = z.grade ? GRADE_COPY[z.grade] : null;
        return (
          <li key={z.zoneKey} className="overflow-hidden rounded-2xl bg-white ring-1 ring-stone-200">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
              onClick={() => setOpen(isOpen ? null : z.zoneKey)}
              data-testid={`zone-row-${z.zoneKey}`}
              aria-expanded={isOpen}
            >
              <span className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: z.grade ? GRADE_FILL[z.grade] : "#e7e5e4" }}
                />
                <span className="font-medium text-stone-800">{z.zoneLabel}</span>
              </span>
              <span className="flex items-center gap-2">
                {grade ? (
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${grade.chip}`}>{grade.label}</span>
                ) : null}
                <span aria-hidden className={`text-stone-400 transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>
              </span>
            </button>

            {isOpen ? (
              <div className="border-t border-stone-100 px-4 py-4" data-testid={`zone-detail-${z.zoneKey}`}>
                {z.summary ? <p className="text-sm leading-relaxed text-stone-600">{z.summary}</p> : null}

                {z.findings.length > 0 ? (
                  <ul className="mt-3 space-y-3">
                    {z.findings.map((f) => (
                      <li key={f.id} className="rounded-xl bg-stone-50 p-3" data-testid={`finding-${f.id}`}>
                        <p className="text-sm font-medium text-stone-800">{f.whatItIs}</p>
                        {f.ifIgnored ? <p className="mt-1 text-sm text-stone-500">If left alone: {f.ifIgnored}</p> : null}
                        {f.timeframe ? <p className="mt-1 text-xs font-medium text-stone-400">{f.timeframe}</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : z.grade === "good" ? (
                  <p className="mt-2 text-sm text-stone-500">Nothing needed here — this zone looks the way it should.</p>
                ) : null}

                {z.photos.length > 0 ? (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {z.photos.map((p) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={p.documentId}
                        src={`/api/record/${code}/photo/${p.documentId}`}
                        alt={`${z.zoneLabel} photo`}
                        loading="lazy"
                        className="aspect-square w-full rounded-lg object-cover ring-1 ring-stone-200"
                        data-testid={`zone-photo-${p.documentId}`}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
