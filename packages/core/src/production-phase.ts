// Production Pulse: phases are to jobs what zones are to inspections (the
// Roof Record capture pattern). Crews advance phases by CAPTURING evidence,
// never by tapping status buttons — the template checklist IS the completion
// definition, Library-versioned so revisions are config, not code.

export type PhaseEvidenceDef = {
  /** Minimum photos carrying this phase's capture context. */
  minPhotos: number;
  /** Shot kinds that must appear at least once (e.g. 'deck', 'magnet_sweep'). */
  requiredShots: string[];
};

export type PhaseTemplateItem = {
  key: string;
  label: string;
  sortOrder: number;
  /** Completion triggers the homeowner photo update (slice 2). */
  customerVisible: boolean;
  expectedDurationHours: number;
  evidence: PhaseEvidenceDef;
};

export type PhaseEvidenceResult = {
  complete: boolean;
  missing: { photos: number; shots: string[] };
};

/** Pure evidence evaluation: photos are { shot } tags from the capture context. */
export function evaluatePhaseEvidence(
  template: PhaseTemplateItem,
  photos: { shot: string | null }[],
): PhaseEvidenceResult {
  const missingPhotos = Math.max(0, template.evidence.minPhotos - photos.length);
  const shots = new Set(photos.map((p) => p.shot).filter((s): s is string => Boolean(s)));
  const missingShots = template.evidence.requiredShots.filter((s) => !shots.has(s));
  return {
    complete: missingPhotos === 0 && missingShots.length === 0,
    missing: { photos: missingPhotos, shots: missingShots },
  };
}

/** Pace lag threshold — a phase is off-pace past expected × this (tenant-overridable). */
export const PHASE_PACE_LAG_FACTOR = 1.5;

export type PhaseProgress = {
  done: number;
  total: number;
  current: { key: string; elapsedHours: number; onPace: boolean } | null;
};

/** The job-card line: "Install — 60%, on pace." */
export function phaseProgress(
  phases: { key: string; status: string; startedAt: Date | null; expectedDurationHours: number }[],
  now: Date,
  paceLagFactor = PHASE_PACE_LAG_FACTOR,
): PhaseProgress {
  const done = phases.filter((p) => p.status === "done" || p.status === "verified").length;
  const current = phases.find((p) => p.status === "in_progress") ?? null;
  return {
    done,
    total: phases.length,
    current: current
      ? (() => {
          const elapsedHours = current.startedAt ? (now.getTime() - current.startedAt.getTime()) / 3600_000 : 0;
          return {
            key: current.key,
            elapsedHours,
            onPace: elapsedHours <= current.expectedDurationHours * paceLagFactor,
          };
        })()
      : null,
  };
}

const shot = (key: string, label: string, sortOrder: number, opts: {
  visible?: boolean; hours?: number; minPhotos?: number; shots?: string[];
} = {}): PhaseTemplateItem => ({
  key, label, sortOrder,
  customerVisible: opts.visible ?? true,
  expectedDurationHours: opts.hours ?? 2,
  evidence: { minPhotos: opts.minPhotos ?? 2, requiredShots: opts.shots ?? [] },
});

/** v1 Library seed — retail vs insurance vs repair differ (owner spec).
 *  Revisions are NEW template versions in the Library, never code edits. */
export const DEFAULT_PHASE_TEMPLATES: Record<"retail" | "insurance" | "repair", PhaseTemplateItem[]> = {
  retail: [
    shot("staged_materials", "Materials staged", 1, { visible: false, hours: 1, minPhotos: 1 }),
    shot("tear_off", "Tear-off", 2, { hours: 4, minPhotos: 3, shots: ["deck"] }),
    shot("deck_repair", "Deck repair", 3, { hours: 2, minPhotos: 2 }),
    shot("dry_in", "Dry-in", 4, { hours: 3, minPhotos: 3, shots: ["underlayment"] }),
    shot("install", "Shingle install", 5, { hours: 8, minPhotos: 4 }),
    shot("penetrations_flashing", "Penetrations & flashing", 6, { hours: 2, minPhotos: 2 }),
    shot("cleanup", "Cleanup", 7, { hours: 1, minPhotos: 2, shots: ["magnet_sweep"] }),
    shot("final_photos", "Final photos", 8, { hours: 1, minPhotos: 3 }),
  ],
  insurance: [
    shot("staged_materials", "Materials staged", 1, { visible: false, hours: 1, minPhotos: 1 }),
    shot("tear_off", "Tear-off", 2, { hours: 4, minPhotos: 3, shots: ["deck"] }),
    shot("deck_repair", "Deck repair", 3, { hours: 2, minPhotos: 2 }),
    shot("dry_in", "Dry-in", 4, { hours: 3, minPhotos: 3, shots: ["underlayment"] }),
    shot("install", "Shingle install", 5, { hours: 8, minPhotos: 4 }),
    shot("penetrations_flashing", "Penetrations & flashing", 6, { hours: 2, minPhotos: 2 }),
    shot("cleanup", "Cleanup", 7, { hours: 1, minPhotos: 2, shots: ["magnet_sweep"] }),
    // Insurance closeouts carry the carrier evidence set.
    shot("final_photos", "Final photos", 8, { hours: 1, minPhotos: 4, shots: ["permit"] }),
  ],
  repair: [
    shot("staged_materials", "Materials staged", 1, { visible: false, hours: 0.5, minPhotos: 1 }),
    shot("repair_work", "Repair work", 2, { hours: 3, minPhotos: 3, shots: ["before", "after"] }),
    shot("cleanup", "Cleanup", 3, { hours: 0.5, minPhotos: 1 }),
  ],
};
