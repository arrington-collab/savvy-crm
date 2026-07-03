import {
  adminDb, withTenant, tenant, appointment, job, property, customer, communication,
  setAppointmentWeatherFlag, rescheduleAppointment, getCrewBusyStarts, getCrewContacts, SlotTakenError,
  and, eq, gte, lte,
} from "@savvy/db";
import {
  parseWeatherConfig, parseFinanceConfig, parseHomeownerConfig, parseEmailConfig,
  assessWeatherRisk, pickRescheduleSlot, instantAtLocalTimeOnDate, formatShortDate,
  buildWeatherMoveHomeownerBody, buildWeatherMoveCrewBody, isWithinQuietHours,
  toCivilDate, tenantsDueAtHour, type WeatherConfig, type HomeownerConfig,
} from "@savvy/core";
import { forecast, getEmailSender, type ForecastGateway } from "@savvy/integrations";
import { getTenantSms } from "../telephony";
import { inngest } from "../client";

type WeatherResult = { flagged: number; cleared: number; rescheduled: number; rescheduledAppointmentIds: string[] };

/** One at-risk crew appt enriched from the join (customer + property + crew). */
type AtRiskRow = {
  id: string; startsAt: Date; endsAt: Date; lat: number | null; lng: number | null;
  crewId: string | null; jobId: string; customerId: string | null;
  phone: string | null; email: string | null; smsOptOut: boolean | null; emailOptOut: boolean | null;
  address: string | null;
};

/**
 * Evaluate one tenant's upcoming scheduled crew appts against the forecast; set/clear weather
 * flags. When autoReschedule is on and a safe crew-free day exists, move the install there, clear
 * the flag, notify homeowner (quiet-hours-safe) + crew, and return the moved appointment ids so the
 * wrapper can emit `appointment/changed`.
 */
export async function evaluateTenantWeather(
  tenantId: string,
  client: ForecastGateway,
  now: Date,
): Promise<WeatherResult> {
  const [t] = await withTenant(tenantId, (tx) => tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)));
  const settings = (t?.settings ?? {}) as { weather?: unknown; finance?: unknown; homeowner?: unknown; email?: unknown };
  const cfg = parseWeatherConfig(settings.weather);
  if (!cfg.enabled) return { flagged: 0, cleared: 0, rescheduled: 0, rescheduledAppointmentIds: [] };
  const tz = parseFinanceConfig(settings.finance).timezone;
  const homeownerCfg = parseHomeownerConfig(settings.homeowner);
  const gmailConnectionId = parseEmailConfig(settings.email).gmailConnectionId ?? null;
  const windowEnd = new Date(now.getTime() + cfg.lookAheadDays * 86_400_000);

  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      id: appointment.id, startsAt: appointment.startsAt, endsAt: appointment.endsAt,
      crewId: appointment.crewId, lat: property.lat, lng: property.lng,
      jobId: appointment.jobId, customerId: job.customerId, address: property.address,
      phone: customer.phone, email: customer.email, smsOptOut: customer.smsOptOut, emailOptOut: customer.emailOptOut,
    })
      .from(appointment)
      .leftJoin(job, eq(job.id, appointment.jobId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(and(eq(appointment.type, "crew"), eq(appointment.status, "scheduled"),
        gte(appointment.startsAt, now), lte(appointment.startsAt, windowEnd))));

  const result: WeatherResult = { flagged: 0, cleared: 0, rescheduled: 0, rescheduledAppointmentIds: [] };
  for (const r of rows as AtRiskRow[]) {
    if (r.lat == null || r.lng == null) continue;
    let days;
    try { days = await client.getForecast({ lat: r.lat, lng: r.lng, days: cfg.lookAheadDays }); }
    catch { continue; } // best-effort: a forecast failure skips this appt
    const apptDate = toCivilDate(r.startsAt.toISOString(), tz);
    const day = days.find((d) => d.date === apptDate);
    if (!day) continue; // beyond horizon / no matching day → leave unchanged
    const risk = assessWeatherRisk(day, cfg);
    if (!risk.atRisk) {
      await setAppointmentWeatherFlag({ tenantId, appointmentId: r.id, note: null });
      result.cleared++;
      continue;
    }

    // At risk. Auto-reschedule only when enabled and the appt is crew-assigned.
    if (!cfg.autoReschedule || r.crewId == null) {
      await setAppointmentWeatherFlag({ tenantId, appointmentId: r.id, note: risk.reason });
      result.flagged++;
      continue;
    }
    const moved = await tryReschedule(
      { tenantId, tz, now, windowEnd, cfg, homeownerCfg, gmailConnectionId }, r, r.crewId, days, apptDate, risk.reason,
    );
    if (moved) { result.rescheduled++; result.rescheduledAppointmentIds.push(r.id); }
    else { await setAppointmentWeatherFlag({ tenantId, appointmentId: r.id, note: risk.reason }); result.flagged++; }
  }
  return result;
}

type MoveCtx = {
  tenantId: string; tz: string; now: Date; windowEnd: Date;
  cfg: WeatherConfig; homeownerCfg: HomeownerConfig; gmailConnectionId: string | null;
};

/** Find the next safe crew-free day and move the appt there; notify on success. Returns true if moved. */
async function tryReschedule(
  ctx: MoveCtx, r: AtRiskRow, crewId: string,
  days: { date: string; maxWindMph: number; precipProbability: number }[],
  apptDate: string, reason: string,
): Promise<boolean> {
  const { tenantId, tz } = ctx;
  const crewBusyDates = new Set(
    (await getCrewBusyStarts({ tenantId, crewId, from: ctx.now, to: ctx.windowEnd, excludeAppointmentId: r.id }))
      .map((d) => toCivilDate(d.toISOString(), tz)),
  );
  for (;;) {
    const target = pickRescheduleSlot({ days, originalCivilDate: apptDate, crewBusyDates, cfg: ctx.cfg });
    if (target == null) return false; // no safe slot → caller does flag-only fallback
    const newStart = instantAtLocalTimeOnDate(target, r.startsAt, tz);
    const newEnd = new Date(newStart.getTime() + (r.endsAt.getTime() - r.startsAt.getTime()));
    try {
      await rescheduleAppointment({ tenantId, appointmentId: r.id, startsAt: newStart, endsAt: newEnd });
    } catch (e) {
      if (e instanceof SlotTakenError) { crewBusyDates.add(target); continue; }
      throw e;
    }
    await setAppointmentWeatherFlag({ tenantId, appointmentId: r.id, note: null });
    await notifyWeatherMove(ctx, r, crewId, formatShortDate(apptDate), formatShortDate(target), reason);
    return true;
  }
}

/** Fail-soft comms: notify homeowner (quiet-hours-gated SMS + always email) and every crew member. */
async function notifyWeatherMove(
  ctx: MoveCtx, r: AtRiskRow, crewId: string,
  originalLabel: string, targetLabel: string, reason: string,
): Promise<void> {
  const { tenantId, tz } = ctx;
  const body = buildWeatherMoveHomeownerBody({ originalLabel, targetLabel, reason });

  if (r.phone && !r.smsOptOut && !isWithinQuietHours(ctx.now, tz, ctx.homeownerCfg.quietHours)) {
    try { const { sender, from } = await getTenantSms(tenantId); await sender.sendSms({ to: r.phone, from, body }); } catch { /* fail-soft: no creds */ }
    await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: r.jobId, customerId: r.customerId, channel: "sms", direction: "outbound", to: r.phone, body, aiHandled: false }));
  }
  if (r.email && !r.emailOptOut) {
    try { await getEmailSender({ gmailConnectionId: ctx.gmailConnectionId }).sendEmail({ to: r.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "Your roofing install has moved", html: `<p>${body}</p>` }); } catch { /* fail-soft */ }
    await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: r.jobId, customerId: r.customerId, channel: "email", direction: "outbound", to: r.email, body, aiHandled: false }));
  }

  const crewBody = buildWeatherMoveCrewBody({ address: r.address ?? "", originalLabel, targetLabel, reason });
  for (const contact of await getCrewContacts({ tenantId, crewId })) {
    if (contact.phone) {
      try { const { sender, from } = await getTenantSms(tenantId); await sender.sendSms({ to: contact.phone, from, body: crewBody }); } catch { /* fail-soft */ }
      await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: r.jobId, customerId: null, channel: "sms", direction: "outbound", to: contact.phone, body: crewBody, aiHandled: false }));
    } else if (contact.email) {
      try { await getEmailSender({ gmailConnectionId: ctx.gmailConnectionId }).sendEmail({ to: contact.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: "Weather move: install rescheduled", html: `<p>${crewBody}</p>` }); } catch { /* fail-soft */ }
      await withTenant(tenantId, (tx) => tx.insert(communication).values({ tenantId, jobId: r.jobId, customerId: null, channel: "email", direction: "outbound", to: contact.email, body: crewBody, aiHandled: false }));
    }
  }
}

export const weatherReschedule = inngest.createFunction(
  { id: "weather-reschedule", concurrency: { limit: 1 } },
  { cron: "0 * * * *" }, // hourly tick; runs each tenant at 05:00 its local time
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
      return tenantsDueAtHour(rows, new Date(), 5).map((t) => t.id);
    });
    let flagged = 0, cleared = 0, rescheduled = 0;
    for (const id of due) {
      const res = await step.run(`weather-${id}`, () => evaluateTenantWeather(id, forecast, new Date()));
      flagged += res.flagged; cleared += res.cleared; rescheduled += res.rescheduled;
      // Emit OUTSIDE step.run so re-runs don't double-fire; one changed-event per moved appt.
      // reason "weather_rescheduled" (not booked) so the homeowner journey re-arms without double-firing.
      for (const apptId of res.rescheduledAppointmentIds) {
        await step.sendEvent(`wx-moved-${apptId}`, { name: "appointment/changed", data: { appointmentId: apptId, tenantId: id, reason: "weather_rescheduled" } });
      }
    }
    return { flagged, cleared, rescheduled };
  },
);
