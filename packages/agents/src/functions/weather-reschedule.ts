import { adminDb, withTenant, tenant, appointment, job, property, setAppointmentWeatherFlag, and, eq, gte, lte } from "@savvy/db";
import { parseWeatherConfig, parseFinanceConfig, assessWeatherRisk, toCivilDate, tenantsDueAtHour } from "@savvy/core";
import { forecast, type ForecastGateway } from "@savvy/integrations";
import { inngest } from "../client";

/** Evaluate one tenant's upcoming scheduled crew appts against the forecast; set/clear weather flags. */
export async function evaluateTenantWeather(
  tenantId: string,
  client: ForecastGateway,
  now: Date,
): Promise<{ flagged: number; cleared: number }> {
  const [t] = await withTenant(tenantId, (tx) => tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)));
  const settings = (t?.settings ?? {}) as { weather?: unknown; finance?: unknown };
  const cfg = parseWeatherConfig(settings.weather);
  if (!cfg.enabled) return { flagged: 0, cleared: 0 };
  const tz = parseFinanceConfig(settings.finance).timezone;
  const windowEnd = new Date(now.getTime() + cfg.lookAheadDays * 86_400_000);

  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ id: appointment.id, startsAt: appointment.startsAt, lat: property.lat, lng: property.lng })
      .from(appointment)
      .leftJoin(job, eq(job.id, appointment.jobId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(and(eq(appointment.type, "crew"), eq(appointment.status, "scheduled"),
        gte(appointment.startsAt, now), lte(appointment.startsAt, windowEnd))));

  let flagged = 0, cleared = 0;
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    let days;
    try { days = await client.getForecast({ lat: r.lat, lng: r.lng, days: cfg.lookAheadDays }); }
    catch { continue; } // best-effort: a forecast failure skips this appt
    const apptDate = toCivilDate(r.startsAt.toISOString(), tz);
    const day = days.find((d) => d.date === apptDate);
    if (!day) continue; // beyond horizon / no matching day → leave unchanged
    const risk = assessWeatherRisk(day, cfg);
    await setAppointmentWeatherFlag({ tenantId, appointmentId: r.id, note: risk.atRisk ? risk.reason : null });
    if (risk.atRisk) flagged++; else cleared++;
  }
  return { flagged, cleared };
}

export const weatherReschedule = inngest.createFunction(
  { id: "weather-reschedule", concurrency: { limit: 1 } },
  { cron: "0 * * * *" }, // hourly tick; runs each tenant at 05:00 its local time
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
      return tenantsDueAtHour(rows, new Date(), 5).map((t) => t.id);
    });
    let flagged = 0, cleared = 0;
    for (const id of due) {
      const res = await step.run(`weather-${id}`, () => evaluateTenantWeather(id, forecast, new Date()));
      flagged += res.flagged; cleared += res.cleared;
    }
    return { flagged, cleared };
  },
);
