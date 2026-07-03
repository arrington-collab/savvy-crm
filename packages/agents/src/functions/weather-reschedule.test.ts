import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, appointment, customer, property, job, communication, crew, crewMember, user, eq } from "@savvy/db";
import { toCivilDate } from "@savvy/core";
import type { ForecastGateway } from "@savvy/integrations";
import { evaluateTenantWeather } from "./weather-reschedule";

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

async function seedWithCrew(): Promise<{ tenantId: string; apptId: string; jobId: string; apptDate: string; tz: string }> {
  const tz = "America/Phoenix";
  const [t] = await adminDb.insert(tenant).values({ name: "WX", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { weather: { enabled: true }, finance: { timezone: tz } } }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "WX Cust", phone: "+15551230000", email: "owner@example.com" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Storm St", lat: 33.4, lng: -112.0 }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const [cr] = await adminDb.insert(crew).values({ tenantId, name: "Crew A" }).returning();
  const [u] = await adminDb.insert(user).values({ tenantId, name: "Installer", email: "crew@example.com", phone: "+15559990000", role: "crew" }).returning();
  await adminDb.insert(crewMember).values({ tenantId, crewId: cr!.id, userId: u!.id });
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  const [a] = await adminDb.insert(appointment).values({ tenantId, jobId: j!.id, customerId: c!.id, type: "crew", status: "scheduled", crewId: cr!.id, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) }).returning();
  return { tenantId, apptId: a!.id, jobId: j!.id, apptDate: toCivilDate(startsAt.toISOString(), tz), tz };
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

    const comms = await withTenant(s.tenantId, (tx) => tx.select({ ch: communication.channel, to: communication.to }).from(communication).where(eq(communication.jobId, s.jobId)));
    // homeowner email + at least the crew member (SMS is quiet-hours-gated, so >= 2 avoids flakiness)
    expect(comms.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to flag-only when no safe day exists in the window", async () => {
    const s = await seedWithCrew();
    const r = await evaluateTenantWeather(s.tenantId, stub([{ date: s.apptDate, maxWindMph: 5, precipProbability: 90 }]), new Date());
    expect(r.rescheduled).toBe(0);
    expect(r.flagged).toBe(1);
    const [a] = await withTenant(s.tenantId, (tx) => tx.select({ note: appointment.weatherNote }).from(appointment).where(eq(appointment.id, s.apptId)));
    expect(a!.note).toBe("Rain 90%");
  });
});
