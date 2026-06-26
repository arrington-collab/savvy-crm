export type ScheduleAppt = {
  id: string;
  type: string | null;
  status: string | null;
  startsAt: string; // ISO
  endsAt: string;   // ISO
  assigneeUserId: string | null;
  assigneeName: string | null;
  customerName: string | null;
  address: string | null;
  jobId: string | null;
  jobType: string | null;
  city: string | null;
};

const DAY_START_MIN = 6 * 60;
const DAY_END_MIN = 20 * 60;
const SPAN_MIN = DAY_END_MIN - DAY_START_MIN;

function partsInTz(iso: string, tz: string): { y: number; mo: number; d: number; minutes: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(iso))) if (p.type !== "literal") map[p.type] = Number(p.value);
  const hour = map["hour"] === 24 ? 0 : map["hour"]!;
  return { y: map["year"]!, mo: map["month"]!, d: map["day"]!, minutes: hour * 60 + map["minute"]! };
}

export function toCivilDate(iso: string, tz: string): string {
  const { y, mo, d } = partsInTz(iso, tz);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function minutesInTz(iso: string, tz: string): number {
  return partsInTz(iso, tz).minutes;
}

function toNoonUTC(civil: string): Date {
  const [y, m, d] = civil.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12));
}

function fromUTC(dt: Date): string {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(civil: string, n: number): string {
  const dt = toNoonUTC(civil);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUTC(dt);
}

export function addWeeks(civil: string, n: number): string {
  return addDays(civil, n * 7);
}

export function addMonths(civil: string, n: number): string {
  const [y, m, d] = civil.split("-").map(Number);
  return fromUTC(new Date(Date.UTC(y!, m! - 1 + n, d!, 12)));
}

function weekday(civil: string): number {
  return toNoonUTC(civil).getUTCDay();
}

export function weekDays(anchor: string): string[] {
  const start = addDays(anchor, -weekday(anchor));
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function appointmentTypeTone(type: string | null): string {
  switch (type) {
    case "inspection": return "var(--agent-scout)";
    case "cm": return "var(--agent-vera)";
    case "crew": return "var(--agent-milo)";
    default: return "var(--text-faint)";
  }
}

export type PositionedAppt = ScheduleAppt & { topPct: number; heightPct: number; tone: string; lane: number; lanes: number };
export type WeekDay = { date: string; weekday: string; blocks: PositionedAppt[] };
export type WeekView = { days: WeekDay[]; hourLabels: string[] };

function position(startMin: number, endMin: number): { topPct: number; heightPct: number } {
  const s = Math.max(DAY_START_MIN, Math.min(startMin, DAY_END_MIN));
  const e = Math.max(s, Math.min(endMin, DAY_END_MIN));
  return {
    topPct: ((s - DAY_START_MIN) / SPAN_MIN) * 100,
    heightPct: Math.max(2, ((e - s) / SPAN_MIN) * 100),
  };
}

function assignLanes(items: { startMin: number; endMin: number }[]): { lane: number; lanes: number }[] {
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.startMin - b.startMin);
  const laneEnds: number[] = [];
  const lane = new Array<number>(items.length).fill(0);
  for (const it of order) {
    let placed = -1;
    for (let l = 0; l < laneEnds.length; l++) {
      if (laneEnds[l]! <= it.startMin) { placed = l; break; }
    }
    if (placed === -1) {
      placed = laneEnds.length;
      laneEnds.push(it.endMin);
    } else {
      laneEnds[placed] = it.endMin;
    }
    lane[it.i] = placed;
  }
  const lanes = Math.max(1, laneEnds.length);
  return lane.map((l) => ({ lane: l, lanes }));
}

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildWeekView(appts: ScheduleAppt[], anchor: string, tz: string): WeekView {
  const dates = weekDays(anchor);
  const hourLabels = Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 + 1 }, (_, i) => {
    const h = DAY_START_MIN / 60 + i;
    const ampm = h < 12 ? "a" : "p";
    const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr}${ampm}`;
  });
  const days: WeekDay[] = dates.map((date) => {
    const dayAppts = appts.filter((a) => toCivilDate(a.startsAt, tz) === date);
    const mins = dayAppts.map((a) => ({
      startMin: minutesInTz(a.startsAt, tz),
      endMin: minutesInTz(a.endsAt, tz),
    }));
    const lanes = assignLanes(mins);
    const blocks: PositionedAppt[] = dayAppts.map((a, i) => ({
      ...a,
      ...position(mins[i]!.startMin, mins[i]!.endMin),
      tone: appointmentTypeTone(a.type),
      ...lanes[i]!,
    }));
    return { date, weekday: WEEKDAY_LABEL[weekday(date)]!, blocks };
  });
  return { days, hourLabels };
}

// ---- month view -----------------------------------------------------------
export type MonthChip = ScheduleAppt & { tone: string };
export type MonthCell = { date: string; day: number; outside: boolean; chips: MonthChip[] };
export type MonthView = { weeks: MonthCell[][] };

export function buildMonthView(appts: ScheduleAppt[], anchor: string, tz: string): MonthView {
  const [y, m] = anchor.split("-").map(Number);
  const firstOfMonth = `${y}-${String(m).padStart(2, "0")}-01`;
  const gridStart = addDays(firstOfMonth, -weekday(firstOfMonth));
  const byDate = new Map<string, MonthChip[]>();
  for (const a of appts) {
    const d = toCivilDate(a.startsAt, tz);
    const list = byDate.get(d) ?? [];
    list.push({ ...a, tone: appointmentTypeTone(a.type) });
    byDate.set(d, list);
  }
  const weeks: MonthCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: MonthCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(gridStart, w * 7 + d);
      row.push({ date, day: Number(date.slice(8)), outside: Number(date.slice(5, 7)) !== m, chips: byDate.get(date) ?? [] });
    }
    weeks.push(row);
  }
  return { weeks };
}

// ---- crew view ------------------------------------------------------------
export type CrewColumn = { userId: string | null; name: string; days: { date: string; weekday: string; appts: ScheduleAppt[] }[]; appts: ScheduleAppt[] };
export type CrewView = { dates: string[]; columns: CrewColumn[] };

// ---- drag: tz inverse + position->time -----------------------------------
/** Inverse of toCivilDate/minutesInTz: a wall-clock day+minutes in `tz` -> UTC ISO instant.
 *  Offset-correction; exact outside the 1h DST spring-forward gap (approximate inside it). */
export function zonedTimeToUtc(civilDate: string, minutes: number, tz: string): string {
  const [y, mo, d] = civilDate.split("-").map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, Math.floor(minutes / 60), minutes % 60);
  const p = partsInTz(new Date(guess).toISOString(), tz); // wall time that `guess` shows in tz
  const wallAsUTC = Date.UTC(p.y, p.mo - 1, p.d, Math.floor(p.minutes / 60), p.minutes % 60);
  const offset = wallAsUTC - guess; // how far tz is from UTC at this instant
  return new Date(guess - offset).toISOString();
}

function snap30(min: number): number { return Math.round(min / 30) * 30; }

/** Inverse of the week grid's vertical positioning: a click offset within a day
 *  column (height px) → minute-of-day, snapped to 30, clamped so a 30-min appt
 *  fits inside the 6a–8p window. `offsetY` is relative to the column's top
 *  (e.g. `clientY - column.getBoundingClientRect().top`), NOT the browser event's
 *  `offsetY`. A non-positive `height` (unmeasured column) falls back to the window start. */
export function minutesFromOffset(offsetY: number, height: number): number {
  if (height <= 0) return DAY_START_MIN;
  const raw = DAY_START_MIN + (offsetY / height) * SPAN_MIN;
  const snapped = snap30(raw);
  return Math.max(DAY_START_MIN, Math.min(snapped, DAY_END_MIN - 30));
}

/** New {startsAt,endsAt} after dragging a week block by `deltaYpx` (within a `gridHeightPx`
 *  6a-8p grid) onto `newDate`. Snaps to 30 min, preserves duration, clamps into the window. */
export function applyDragToWeek(
  appt: { startsAt: string; endsAt: string }, deltaYpx: number, gridHeightPx: number, newDate: string, tz: string,
): { startsAt: string; endsAt: string } {
  const startMin = minutesInTz(appt.startsAt, tz);
  const durMin = (Date.parse(appt.endsAt) - Date.parse(appt.startsAt)) / 60000;
  const deltaMin = Math.round((deltaYpx / gridHeightPx) * SPAN_MIN);
  const newStart = Math.max(DAY_START_MIN, Math.min(snap30(startMin + deltaMin), DAY_END_MIN - durMin));
  const startsAt = zonedTimeToUtc(newDate, newStart, tz);
  const endsAt = new Date(Date.parse(startsAt) + durMin * 60000).toISOString();
  return { startsAt, endsAt };
}

/** New {startsAt,endsAt} after dragging a month chip onto `newDate` (keeps the time-of-day). */
export function applyDragToMonth(
  appt: { startsAt: string; endsAt: string }, newDate: string, tz: string,
): { startsAt: string; endsAt: string } {
  const startMin = minutesInTz(appt.startsAt, tz);
  const durMin = (Date.parse(appt.endsAt) - Date.parse(appt.startsAt)) / 60000;
  const startsAt = zonedTimeToUtc(newDate, startMin, tz);
  const endsAt = new Date(Date.parse(startsAt) + durMin * 60000).toISOString();
  return { startsAt, endsAt };
}

export function buildCrewView(appts: ScheduleAppt[], anchor: string, tz: string, crew: { id: string; name: string }[]): CrewView {
  const dates = weekDays(anchor);
  const inWeek = appts.filter((a) => dates.includes(toCivilDate(a.startsAt, tz)));
  const mkColumn = (userId: string | null, name: string): CrewColumn => {
    const mine = inWeek.filter((a) => a.assigneeUserId === userId);
    return {
      userId, name,
      days: dates.map((date) => ({ date, weekday: WEEKDAY_LABEL[weekday(date)]!, appts: mine.filter((a) => toCivilDate(a.startsAt, tz) === date) })),
      appts: mine,
    };
  };
  const columns = crew.map((c) => mkColumn(c.id, c.name));
  if (inWeek.some((a) => a.assigneeUserId === null)) columns.push(mkColumn(null, "Unassigned"));
  return { dates, columns };
}

/** A spoken, relative label for an instant in `tz` — e.g. "today at 9:00 AM",
 *  "tomorrow at 2:30 PM", "Saturday at 10:00 AM" (no year). For the voice agent
 *  to read times naturally instead of a raw ISO timestamp. */
export function spokenSlotLabel(iso: string, tz: string, nowIso: string): string {
  const day = toCivilDate(iso, tz);
  const today = toCivilDate(nowIso, tz);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
  let dayLabel: string;
  if (day === today) dayLabel = "today";
  else if (day === addDays(today, 1)) dayLabel = "tomorrow";
  else dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date(iso));
  return `${dayLabel} at ${time}`;
}
