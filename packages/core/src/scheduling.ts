import { z } from "./schemas";
import { APPOINTMENT_TYPE, type AppointmentType } from "./enums";
import { MESSAGE_CHANNEL } from "./enums";

// [openHour, closeHour] in local 24h; [] = closed that day.
const dayHours = z.union([z.tuple([z.number(), z.number()]), z.tuple([])]);
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];

const typeCfg = z.object({ durationMin: z.number().int().positive(), bufferMin: z.number().int().min(0) });
const reminderCfg = z.object({ offsetH: z.number().positive(), channel: z.enum([...MESSAGE_CHANNEL]) });

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
});

export type SchedulingConfig = {
  hours: Record<Weekday, number[]>;
  slotGranularityMin: number;
  bookingHorizonDays: number;
  types: Record<AppointmentType, { durationMin: number; bufferMin: number }>;
  reminders: { offsetH: number; channel: "sms" | "email" }[];
};

export function parseSchedulingConfig(raw: unknown): SchedulingConfig {
  const p = schema.parse(raw ?? {});
  return {
    hours: { ...DEFAULTS.hours, ...p.hours } as Record<Weekday, number[]>,
    slotGranularityMin: p.slotGranularityMin,
    bookingHorizonDays: p.bookingHorizonDays,
    types: { ...DEFAULTS.types, ...p.types } as SchedulingConfig["types"],
    reminders: p.reminders,
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
