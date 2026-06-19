import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb, tenant, user, customer, property, lead, appointment,
  rescheduleAppointment, eq, and,
} from "@savvy/db";
import { signPayloadToken, toCivilDate } from "@savvy/core";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

const SECRET = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
const CUSTOMER_PHONE = "+15555558888";

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 500));
  }
}

test("scheduling: book via slot-picker -> /schedule -> no-double-book -> reschedule -> inbound CANCEL", async ({
  page,
  request,
}) => {
  // ---- Setup: a bookable lead for the e2e tenant -------------------------
  // An owner to be the assignee (booking-action falls back to first owner/rep,
  // but we assign the lead explicitly so slots/booking are deterministic).
  const [owner] = await adminDb.insert(user).values({
    tenantId, name: "Owner Olga", email: `owner-${Date.now()}@e2e.test`, role: "owner",
  }).returning();

  const [cust] = await adminDb.insert(customer).values({
    tenantId, name: "Booking Bob", phone: CUSTOMER_PHONE,
  }).returning();

  // Property needs lat/lng so the cluster path in getSlotsForToken is exercised.
  const [prop] = await adminDb.insert(property).values({
    tenantId, customerId: cust!.id, address: "123 Slot St", lat: 33.45, lng: -112.07,
  }).returning();

  // convertLeadToJob requires customerId + propertyId on the lead.
  const [ld] = await adminDb.insert(lead).values({
    tenantId, customerId: cust!.id, propertyId: prop!.id,
    status: "new", source: "e2e", assignedUserId: owner!.id,
  }).returning();

  // Signed slot-picker token (matches the app's payload shape + default secret).
  const token = signPayloadToken(
    { leadId: ld!.id, tenantId, type: "inspection" },
    SECRET,
  );

  // ---- 1) Open the slot picker, assert slots render, click the first ------
  await page.goto(`/book/${token}`);
  await expect(page.getByRole("heading", { name: "Pick a time" })).toBeVisible();

  // Slots are buttons labeled with a localized date. There should be >=1 in the
  // 14-day horizon (Mon-Fri 8-17 UTC). Grab the first slot button and book it.
  const slotButtons = page.locator("main button");
  await expect(slotButtons.first()).toBeVisible();
  const firstSlotLabel = (await slotButtons.first().textContent())?.trim() ?? "";
  expect(firstSlotLabel.length).toBeGreaterThan(0);
  await slotButtons.first().click();

  // Confirmation renders and a scheduled appointment row now exists.
  await expect(page.getByText("You're booked!")).toBeVisible();

  const appt = await waitFor(async () => {
    const rows = await adminDb.select().from(appointment)
      .where(and(eq(appointment.tenantId, tenantId), eq(appointment.assigneeUserId, owner!.id)));
    return rows.find((r) => r.status === "scheduled");
  });
  expect(appt.type).toBe("inspection");
  expect(appt.customerId).toBe(cust!.id);
  const bookedJobId = appt.jobId;

  // ---- 2) It shows on /schedule (TEST_MODE bypasses Clerk) ----------------
  // The booked slot may be in the current or next week; navigate to its week
  // (anchor = the appt's civil date in the tenant tz; e2e tenant uses default America/Phoenix).
  const apptAnchor = toCivilDate(appt.startsAt.toISOString(), "America/Phoenix");
  await page.goto(`/schedule?anchor=${apptAnchor}`);
  await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();
  // The booked appointment renders as a calendar block showing the customer name.
  const apptBlock = page.getByTestId("appt-block").filter({ hasText: "Booking Bob" });
  await expect(apptBlock.first()).toBeVisible();

  // ---- 3) No-double-book: the EXCLUDE constraint backstop -----------------
  // A second SCHEDULED appointment for the same assignee that overlaps the
  // booked range must violate appointment_no_overlap (Postgres 23P01).
  let dbErr: unknown;
  try {
    await adminDb.insert(appointment).values({
      tenantId, jobId: bookedJobId, customerId: cust!.id, type: "inspection",
      assigneeUserId: owner!.id, status: "scheduled",
      startsAt: appt.startsAt, endsAt: appt.endsAt,
    });
  } catch (e) {
    dbErr = e;
  }
  expect((dbErr as { code?: string } | undefined)?.code).toBe("23P01");

  // ---- 4) Reschedule: move the appointment +7 days, old slot frees up -----
  const oldStart = appt.startsAt.getTime();
  const newStart = new Date(appt.startsAt.getTime() + 7 * 86400_000);
  const newEnd = new Date(appt.endsAt.getTime() + 7 * 86400_000);
  await rescheduleAppointment({
    tenantId, appointmentId: appt.id, startsAt: newStart, endsAt: newEnd,
  });

  const [moved] = await adminDb.select().from(appointment).where(eq(appointment.id, appt.id));
  expect(moved!.startsAt.getTime()).toBe(newStart.getTime());
  // Old slot is free: no scheduled appointment for this assignee at the old time.
  const stillAtOld = await adminDb.select().from(appointment)
    .where(and(eq(appointment.assigneeUserId, owner!.id), eq(appointment.status, "scheduled")));
  expect(stillAtOld.some((r) => r.startsAt.getTime() === oldStart && r.id === appt.id)).toBe(false);

  // ---- 5) Inbound CANCEL via the real Twilio webhook ----------------------
  // `To` = tenant inbound phone (routes to tenant); `From` = the customer phone.
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  const res = await request.post("/api/twilio/inbound", {
    form: { To: t!.inboundPhone!, From: CUSTOMER_PHONE, Body: "CANCEL", MessageSid: "SMcancel-e2e" },
  });
  expect(res.ok()).toBeTruthy();

  // The appointment flips to canceled.
  await waitFor(async () => {
    const [row] = await adminDb.select().from(appointment).where(eq(appointment.id, appt.id));
    return row && row.status === "canceled" ? row : undefined;
  });
  const [canceled] = await adminDb.select().from(appointment).where(eq(appointment.id, appt.id));
  expect(canceled!.status).toBe("canceled");
});
