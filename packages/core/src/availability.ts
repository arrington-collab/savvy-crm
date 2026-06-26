export type RepBusy = { userId: string; busy: { startsAt: Date; endsAt: Date }[] };

/**
 * Reps with no busy interval overlapping the requested window.
 * Overlap = busy.start < requested.end AND busy.end > requested.start
 * (edge-touching is NOT an overlap). Pure; the DB-fed version lives in the service layer.
 */
export function repsFreeAt(args: {
  requested: { startsAt: Date; endsAt: Date };
  reps: RepBusy[];
}): string[] {
  const rs = args.requested.startsAt.getTime();
  const re = args.requested.endsAt.getTime();
  return args.reps
    .filter((r) => !r.busy.some((b) => b.startsAt.getTime() < re && b.endsAt.getTime() > rs))
    .map((r) => r.userId);
}
