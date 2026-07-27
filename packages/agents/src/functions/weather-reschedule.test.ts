import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, appointment, customer, property, job, communication, crew, crewMember, user, eq, suppress } from "@savvy/db";
import { toCivilDate } from "@savvy/core";
import type { ForecastGateway } from "@savvy/integrations";
import { evaluateTenantWeather } from "./weather-reschedule";

/** Today's date at a fixed UTC hour that is 09:00 America/Phoenix (UTC-7, no DST) —
 *  outside the default 21→08 homeowner quiet window, so the homeowner SMS send
 *  path is actually entered (not short-circuited by the quiet-hours guard). */
function midMorningToday(): Date {
  const d = new Date();
  d.setUTCHours(16, 0, 0, 0);
  return d;
}

async function seed(): Promise<{ tenantId: string; apptId: string; apptDate: string; tz: string }> {
  const tz = "America/Phoenix";
  const [t] = await adminDb.insert(tenant).values({ name: "WX", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { weather: { enabled: true }, finance: { timezone: tz } } }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "WX Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Storm St", lat: 33.4, lng: -112.0 }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  const [a] = await adminDb.insert(appointment).values({ tenantId, jobId: j!.id, customerId: c!.id, type: "crew", status: "scheduled", startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) }).returning();
  return { tenantId, apptId: a!.id, apptDate: toCivilDate(startsAt.toISOString(), tz), tz };
}

async function seedWithCrew(): Promise<{ tenantId: string; apptId: string; jobId: string; customerId: string; phone: string; apptDate: string; tz: string }> {
  const tz = "America/Phoenix";
  const [t] = await adminDb.insert(tenant).values({ name: "WX", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { weather: { enabled: true }, finance: { timezone: tz } } }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "WX Cust", phone: "+15551230000", email: "owner@example.com", smsConsentAt: new Date("2026-01-01") }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Storm St", lat: 33.4, lng: -112.0 }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const [cr] = await adminDb.insert(crew).values({ tenantId, name: "Crew A" }).returning();
  const [u] = await adminDb.insert(user).values({ tenantId, name: "Installer", email: "crew@example.com", phone: "+15559990000", role: "crew" }).returning();
  await adminDb.insert(crewMember).values({ tenantId, crewId: cr!.id, userId: u!.id });
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  const [a] = await adminDb.insert(appointment).values({ tenantId, jobId: j!.id, customerId: c!.id, type: "crew", status: "scheduled", crewId: cr!.id, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) }).returning();
  return { tenantId, apptId: a!.id, jobId: j!.id, customerId: c!.id, phone: c!.phone as string, apptDate: toCivilDate(startsAt.toISOString(), tz), tz };
}

function stub(days: Array<{ date: string; maxWindMph: number; precipProbability: number }>): ForecastGateway {
  return { async getForecast() { return days.map((d) => ({ ...d, shortForecast: "x" })); } };
}

describe("evaluateTenantWeather", () => {
  it("flags an at-risk crew appt, then clears when the forecast is clear", async () => {
    const { tenantId, apptId, apptDate } = await seed();
    const now = new Date();

    const r1 = await evaluateTenantWeather(tenantId, stub([{ date: apptDate, maxWindMph: 5, precipProbability: 90 }]), now);
    expect(r1.flagged).toBe(1);
    const [a] = await withTenant(tenantId, (tx) => tx.select({ n: appointment.weatherNote }).from(appointment).where(eq(appointment.id, apptId)));
    expect(a!.n).toBe("Rain 90%");

    const r2 = await evaluateTenantWeather(tenantId, stub([{ date: apptDate, maxWindMph: 5, precipProbability: 0 }]), now);
    expect(r2.cleared).toBe(1);
    const [b] = await withTenant(tenantId, (tx) => tx.select({ f: appointment.weatherFlaggedAt }).from(appointment).where(eq(appointment.id, apptId)));
    expect(b!.f).toBeNull();
  });

  it("no-ops when weather disabled", async () => {
    const { tenantId } = await seed();
    await withTenant(tenantId, (tx) => tx.update(tenant).set({ settings: { weather: { enabled: false } } }).where(eq(tenant.id, tenantId)));
    const r = await evaluateTenantWeather(tenantId, stub([]), new Date());
    expect(r).toEqual({ flagged: 0, cleared: 0, rescheduled: 0, rescheduledAppointmentIds: [] });
  });

  it("auto-reschedules an at-risk crew appt to the next safe, crew-free day and notifies", async () => {
    const s = await seedWithCrew();               // appt has crewId; customer has phone+email
    const now = new Date();
    // apptDate is at-risk; the day after is clear.
    const nextDay = toCivilDate(new Date(new Date(`${s.apptDate}T12:00:00Z`).getTime() + 86_400_000).toISOString(), s.tz);
    const r = await evaluateTenantWeather(
      s.tenantId,
      stub([{ date: s.apptDate, maxWindMph: 5, precipProbability: 90 }, { date: nextDay, maxWindMph: 5, precipProbability: 0 }]),
      now,
    );

    expect(r.rescheduled).toBe(1);
    expect(r.rescheduledAppointmentIds).toEqual([s.apptId]);

    const [a] = await withTenant(s.tenantId, (tx) => tx.select({ startsAt: appointment.startsAt, note: appointment.weatherNote }).from(appointment).where(eq(appointment.id, s.apptId)));
    expect(toCivilDate(a!.startsAt.toISOString(), s.tz)).toBe(nextDay); // moved
    expect(a!.note).toBeNull();                                         // flag cleared

    const comms = await withTenant(s.tenantId, (tx) => tx.select({ ch: communication.channel, to: communication.to, customerId: communication.customerId }).from(communication).where(eq(communication.jobId, s.jobId)));
    // homeowner email + at least the crew member (SMS is quiet-hours-gated, so >= 2 avoids flakiness)
    expect(comms.length).toBeGreaterThanOrEqual(2);
    // at least one crew-notify row must have customerId === null (not the homeowner row)
    expect(comms.some((c) => c.customerId === null)).toBe(true);
  });

  it("flag-only (no move) when autoReschedule is false even with a safe day available", async () => {
    const s = await seedWithCrew();
    // Turn off auto-reschedule but leave weather enabled — the safety valve must be honoured.
    await withTenant(s.tenantId, (tx) =>
      tx.update(tenant).set({ settings: { weather: { enabled: true, autoReschedule: false }, finance: { timezone: s.tz } } }).where(eq(tenant.id, s.tenantId)),
    );
    const nextDay = toCivilDate(new Date(new Date(`${s.apptDate}T12:00:00Z`).getTime() + 86_400_000).toISOString(), s.tz);
    const r = await evaluateTenantWeather(
      s.tenantId,
      stub([{ date: s.apptDate, maxWindMph: 5, precipProbability: 90 }, { date: nextDay, maxWindMph: 5, precipProbability: 0 }]),
      new Date(),
    );
    expect(r.rescheduled).toBe(0);
    expect(r.flagged).toBe(1);
    // Appointment must NOT have moved — civil date stays the same.
    const [a] = await withTenant(s.tenantId, (tx) => tx.select({ startsAt: appointment.startsAt, note: appointment.weatherNote }).from(appointment).where(eq(appointment.id, s.apptId)));
    expect(toCivilDate(a!.startsAt.toISOString(), s.tz)).toBe(s.apptDate);
    expect(a!.note).toBeTruthy(); // weatherNote set
  });

  it("falls back to flag-only when no safe day exists in the window", async () => {
    const s = await seedWithCrew();
    const r = await evaluateTenantWeather(s.tenantId, stub([{ date: s.apptDate, maxWindMph: 5, precipProbability: 90 }]), new Date());
    expect(r.rescheduled).toBe(0);
    expect(r.flagged).toBe(1);
    const [a] = await withTenant(s.tenantId, (tx) => tx.select({ note: appointment.weatherNote }).from(appointment).where(eq(appointment.id, s.apptId)));
    expect(a!.note).toBe("Rain 90%");
  });

  // Compliance follow-up: the homeowner leg of the weather-move notification
  // previously called sender.sendSms directly, bypassing the global
  // contact_suppression list. Proves guardedSms is wired for the HOMEOWNER
  // leg only: a consented, non-opted-out homeowner who is globally suppressed
  // is not texted, and the logged communication row reflects the blocked
  // verdict rather than fabricating a "delivered" record. The crew leg
  // (customerId === null rows) is exempt from homeowner consent/suppression
  // and must still be notified normally.
  it("globally suppressed homeowner → crew-day SMS not sent, comm body reflects the block (crew leg unaffected)", async () => {
    const s = await seedWithCrew();
    await suppress({ tenantId: s.tenantId, phoneE164: s.phone, channel: "sms", reason: "stop", source: "test" });
    const now = midMorningToday(); // outside quiet hours so the send path is entered
    const nextDay = toCivilDate(new Date(new Date(`${s.apptDate}T12:00:00Z`).getTime() + 86_400_000).toISOString(), s.tz);

    const r = await evaluateTenantWeather(
      s.tenantId,
      stub([{ date: s.apptDate, maxWindMph: 5, precipProbability: 90 }, { date: nextDay, maxWindMph: 5, precipProbability: 0 }]),
      now,
    );
    expect(r.rescheduled).toBe(1);

    const comms = await withTenant(s.tenantId, (tx) =>
      tx.select({ ch: communication.channel, body: communication.body, customerId: communication.customerId }).from(communication).where(eq(communication.jobId, s.jobId)),
    );
    const homeownerSms = comms.find((c) => c.ch === "sms" && c.customerId === s.customerId);
    expect(homeownerSms).toBeDefined();
    expect(homeownerSms!.body).toContain("blocked: suppressed");
    expect(homeownerSms!.body).not.toContain("we've moved your roof install"); // never the real move-body text

    // Crew leg (customerId null) is exempt from homeowner suppression — still notified.
    const crewSms = comms.find((c) => c.ch === "sms" && c.customerId === null);
    expect(crewSms).toBeDefined();
    expect(crewSms!.body).toContain("Weather move:");
  });
});
