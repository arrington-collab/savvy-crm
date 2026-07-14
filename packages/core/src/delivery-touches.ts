// Production Pulse slice 2 §0 (owner decision): material delivery gets TWO
// homeowner texts — 3 days out and the night before — and BOTH must say
// clearly that delivery day is not build day. Extends the §F evening-before
// machinery (same hour config, same quiet-hour push) rather than duplicating it.

import { nextAllowedSendTime } from "./quiet-hours";
import { instantAtLocalHourOnDayOf } from "./tz";
import type { HomeownerConfig } from "./homeowner";

export type DeliveryTouch = { kind: "delivery_3day" | "delivery_eve"; fireAt: Date; body: string };

function friendlyDay(d: Date, tz: string): string {
  return d.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" });
}

function deliveryBody(deliveryAt: Date, buildStartsAt: Date | null, tz: string): string {
  const deliveryDay = friendlyDay(deliveryAt, tz);
  const buildLine = buildStartsAt
    ? `your crew starts ${friendlyDay(buildStartsAt, tz)}`
    : "we'll confirm your build date shortly — the crew starts then, not delivery day";
  return (
    `Your materials arrive ${deliveryDay} — that's just the delivery; ${buildLine}. ` +
    `The pallet may sit on or near your driveway — let us know if we should place it somewhere specific.`
  );
}

/**
 * Both delivery touches still in the future, quiet-hour-pushed, each carrying
 * the delivery≠build language with the build date merged when the schedule
 * knows it. Pure — the Inngest wrapper sleeps and sends.
 */
export function buildDeliveryTouches(
  deliveryAt: Date | null,
  buildStartsAt: Date | null,
  tz: string,
  cfg: HomeownerConfig,
  now: Date,
): DeliveryTouch[] {
  if (!deliveryAt) return [];
  const body = deliveryBody(deliveryAt, buildStartsAt, tz);
  const hour = cfg.crewJourney.deliveryEveHour;

  const legs: DeliveryTouch[] = [];
  const threeDayAnchor = new Date(deliveryAt.getTime() - 3 * 24 * 3_600_000);
  const threeDayFire = nextAllowedSendTime(instantAtLocalHourOnDayOf(threeDayAnchor, tz, hour), tz, cfg.quietHours);
  if (threeDayFire.getTime() > now.getTime()) legs.push({ kind: "delivery_3day", fireAt: threeDayFire, body });

  const eveAnchor = new Date(deliveryAt.getTime() - 24 * 3_600_000);
  const eveFire = nextAllowedSendTime(instantAtLocalHourOnDayOf(eveAnchor, tz, hour), tz, cfg.quietHours);
  if (eveFire.getTime() > now.getTime()) legs.push({ kind: "delivery_eve", fireAt: eveFire, body });

  return legs;
}
