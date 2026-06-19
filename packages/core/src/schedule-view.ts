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
