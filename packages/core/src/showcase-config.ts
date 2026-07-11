/** Single source of truth for "Show the Machine Working" thresholds (spec §3). */
export const SHOWCASE = {
  /** Reaper marks running rows older than this many minutes error/timed_out. */
  RUN_STALE_MINUTES: 10,
  /** Feed / card poll cadence, seconds. */
  POLL_SECONDS: 15,
  /** UI never shows a live spinner for a run older than this many seconds. */
  SPINNER_MAX_SECONDS: 90,
  /** A card goes cold past this many days since last touch. */
  COLD_DAYS: 7,
  /** Target wall-clock length of a day replay, seconds. */
  REPLAY_SECONDS: 90,
} as const;
