import { adminDb, withTenant, tenant, appointment, job, property, setAppointmentWeatherFlag, and, eq, gte, lte } from "@savvy/db";
import { parseWeatherConfig, parseFinanceConfig, assessWeatherRisk, toCivilDate } from "@savvy/core";
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
  { cron: "TZ=America/Phoenix 0 5 * * *" }, // daily 05:00
  async ({ step }) => {
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    let flagged = 0, cleared = 0;
    for (const t of tenants) {
      const res = await step.run(`weather-${t.id}`, () => evaluateTenantWeather(t.id, forecast, new Date()));
      flagged += res.flagged; cleared += res.cleared;
    }
    return { flagged, cleared };
  },
);
