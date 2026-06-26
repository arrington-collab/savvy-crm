import { z } from "./schemas";
import { toCivilDate, addDays, zonedTimeToUtc } from "./schedule-view";
import { APPOINTMENT_TYPE, type AppointmentType } from "./enums";
import { MESSAGE_CHANNEL } from "./enums";

// [openHour, closeHour] in local 24h; [] = closed that day.
const dayHours = z.union([z.tuple([z.number(), z.number()]), z.tuple([])]);
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];

const typeCfg = z.object({ durationMin: z.number().int().positive(), bufferMin: z.number().int().min(0) });
const reminderCfg = z.object({ offsetH: z.number().positive(), channel: z.enum([...MESSAGE_CHANNEL]) });

const latLngCfg = z.object({ lat: z.number(), lng: z.number() });
const driveTimeCfg = z.object({
  wSoon: z.number().default(0.5),
  wDrive: z.number().default(0.3),
  wCluster: z.number().default(0.2),
  driveHalfMin: z.number().positive().default(20),
});
const DRIVE_DEFAULTS = { wSoon: 0.5, wDrive: 0.3, wCluster: 0.2, driveHalfMin: 20 } as const;

const DEFAULTS = {
  hours: { mon: [8, 17], tue: [8, 17], wed: [8, 17], thu: [8, 17], fri: [8, 17], sat: [], sun: [] },
  slotGranularityMin: 30,
  bookingHorizonDays: 14,
  types: {
    inspection: { durationMin: 60, bufferMin: 30 },
    cm: { durationMin: 60, bufferMin: 15 },
    crew: { durationMin: 480, bufferMin: 0 },
  },
  reminders: [
    { offsetH: 24, channel: "sms" },
    { offsetH: 2, channel: "sms" },
  ],
} as const;

const schema = z.object({
  hours: z.record(z.enum([...WEEKDAYS]), dayHours).default({}),
  slotGranularityMin: z.number().int().positive().default(DEFAULTS.slotGranularityMin),
  bookingHorizonDays: z.number().int().positive().default(DEFAULTS.bookingHorizonDays),
  types: z.record(z.enum([...APPOINTMENT_TYPE]), typeCfg).default({}),
  reminders: z.array(reminderCfg).default([...DEFAULTS.reminders]),
  office: latLngCfg.optional(),
  driveTime: driveTimeCfg.default({}),
});

export type SchedulingConfig = {
  hours: Record<Weekday, number[]>;
  slotGranularityMin: number;
  bookingHorizonDays: number;
  types: Record<AppointmentType, { durationMin: number; bufferMin: number }>;
  reminders: { offsetH: number; channel: "sms" | "email" }[];
  office?: { lat: number; lng: number };
  driveTime: { wSoon: number; wDrive: number; wCluster: number; driveHalfMin: number };
};

export function parseSchedulingConfig(raw: unknown): SchedulingConfig {
  const p = schema.parse(raw ?? {});
  return {
    hours: { ...DEFAULTS.hours, ...p.hours } as Record<Weekday, number[]>,
    slotGranularityMin: p.slotGranularityMin,
    bookingHorizonDays: p.bookingHorizonDays,
    types: { ...DEFAULTS.types, ...p.types } as SchedulingConfig["types"],
    reminders: p.reminders,
    office: p.office,
    driveTime: { ...DRIVE_DEFAULTS, ...p.driveTime },
  };
}

export { WEEKDAYS };
export type { Weekday };

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type BusyInterval = { startsAt: Date; endsAt: Date; lat?: number; lng?: number };
export type Slot = { startsAt: Date; endsAt: Date; score: number };

const WD_INDEX: Record<number, Weekday> = { 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat", 0: "sun" };

export function computeOpenSlots(input: {
  config: SchedulingConfig;
  type: AppointmentType;
  existingAppts: BusyInterval[];
  fromDate: Date;
  now: Date;
  clusterAround?: { lat: number; lng: number };
  tz: string;
}): Slot[] {
  const { config, type, existingAppts, fromDate, now, clusterAround, tz } = input;
  const t = config.types[type];
  const slotMs = config.slotGranularityMin * 60_000;
  const durMs = t.durationMin * 60_000;
  const bufMs = t.bufferMin * 60_000;
  const out: Slot[] = [];

  const startCivil = toCivilDate(fromDate.toISOString(), tz); // fromDate's local calendar date
  for (let day = 0; day < config.bookingHorizonDays; day++) {
    const civil = addDays(startCivil, day); // "YYYY-MM-DD" local calendar date in tenant tz
    const wd = WD_INDEX[new Date(`${civil}T00:00:00Z`).getUTCDay()]!;
    const hours = config.hours[wd];
    if (!hours || hours.length === 0) continue;
    const [openH, closeH] = hours as [number, number];

    // Build the day's window from tenant-LOCAL hours, converted to the correct UTC instants.
    const dayOpen = new Date(zonedTimeToUtc(civil, openH * 60, tz));
    const dayClose = new Date(zonedTimeToUtc(civil, closeH * 60, tz));

    // A slot is only bookable if the appointment + its buffer fits inside the window.
    for (let start = dayOpen.getTime(); start + durMs + bufMs <= dayClose.getTime(); start += slotMs) {
      const s = new Date(start);
      const e = new Date(start + durMs);
      if (s.getTime() < now.getTime()) continue;
      // Overlap check against existing appts, padded by buffer on both sides.
      const blocked = existingAppts.some((a) =>
        start - bufMs < a.endsAt.getTime() && a.startsAt.getTime() < start + durMs + bufMs,
      );
      if (blocked) continue;
      out.push({ startsAt: s, endsAt: e, score: 0 });
    }
  }

  // Proximity scoring: higher when near the day's existing cluster / target property.
  if (clusterAround) {
    for (const slot of out) {
      const sameDay = existingAppts.filter(
        // Group by the appointment's local calendar date in the tenant tz.
        (a) => a.lat != null && a.lng != null && toCivilDate(a.startsAt.toISOString(), tz) === toCivilDate(slot.startsAt.toISOString(), tz),
      );
      const anchor = sameDay.length
        ? sameDay
        : ([{ ...clusterAround, startsAt: slot.startsAt, endsAt: slot.endsAt } as BusyInterval]);
      const minMeters = Math.min(
        ...anchor.map((a) => haversineMeters({ lat: a.lat!, lng: a.lng! }, clusterAround)),
      );
      slot.score = 1 / (1 + minMeters / 1000); // 0..1, closer = higher
    }
  }

  return out.sort((a, b) => b.score - a.score || a.startsAt.getTime() - b.startsAt.getTime());
}

// A same-day slot must always outrank any future slot (speed-to-lead).
const TODAY_BONUS = 1000;

export type RankedSlot = Slot & { driveMinutes: number | null };

// Blend the existing slot score (clustering) with soonest-feasible + drive-time, deterministically.
// When a slot's driveMinutes is null, its drive weight is dropped and the remaining weights renormalize.
export function rankSlots(args: {
  slots: Slot[];
  driveMinutesBySlotIndex: (number | null)[];
  weights: SchedulingConfig["driveTime"];
  todayCutoff?: Date;
}): RankedSlot[] {
  const { slots, driveMinutesBySlotIndex, weights, todayCutoff } = args;
  if (slots.length === 0) return [];
  const times = slots.map((s) => s.startsAt.getTime());
  const earliest = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - earliest);

  return slots
    .map((s, i) => {
      const soonScore = 1 - (s.startsAt.getTime() - earliest) / span; // 1 (soonest) .. 0
      const dm = driveMinutesBySlotIndex[i] ?? null;
      const driveScore = dm == null ? 0 : 1 / (1 + dm / weights.driveHalfMin);
      const wDrive = dm == null ? 0 : weights.wDrive;
      const norm = weights.wSoon + weights.wCluster + wDrive;
      const base = (weights.wSoon * soonScore + weights.wCluster * s.score + wDrive * driveScore) / norm;
      const todayBump = todayCutoff && s.startsAt.getTime() <= todayCutoff.getTime() ? TODAY_BONUS : 0;
      // todayBump steers SORT ORDER only — the returned score stays the true ranking score
      // (without the bonus), so downstream consumers of `score` see the same value with or
      // without a cutoff.
      return { startsAt: s.startsAt, endsAt: s.endsAt, score: base, driveMinutes: dm, sortKey: base + todayBump };
    })
    .sort((a, b) => b.sortKey - a.sortKey || a.startsAt.getTime() - b.startsAt.getTime())
    .map(({ sortKey, ...rest }) => rest);
}
