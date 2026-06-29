import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  withTenant, bookAppointment,
  customer, property, job, appointment, user, crew,
  eq, and,
} from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

// Anchor on a fixed future Monday so the week is deterministic and empty for our seeds.
// 2026-08-03 is a Monday.
const ANCHOR = "2026-08-03";

/**
 * Seeds a customer + property + job for the e2e tenant.
 * Uses withTenant (respects RLS) matching how pipeline.spec.ts seeds data.
 * customer.phone is nullable; property.address is notNull.
 * job.type and job.stage are notNull (have defaults but we supply them explicitly).
 */
async function seedJob(name: string, address: string) {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx
      .insert(customer)
      .values({ tenantId, name, phone: "+15555550111" })
      .returning();
    const [p] = await tx
      .insert(property)
      .values({ tenantId, customerId: c!.id, address })
      .returning();
    const [j] = await tx
      .insert(job)
      .values({
        tenantId,
        customerId: c!.id,
        propertyId: p!.id,
        type: "retail",
        stage: "lead",
        valueEstimate: 1000000,
      })
      .returning();
    return { customerId: c!.id, jobId: j!.id };
  });
}

// ---------------------------------------------------------------------------
// Click-Y → time analysis:
//   Column height = 560px, spans 6:00am – 8:00pm (DAY_START_MIN=360, SPAN_MIN=840).
//   minutesFromOffset(280, 560) = snap30(360 + 0.5*840) = snap30(780) = 780 = 13:00 local.
//   America/Phoenix is UTC-7 (no DST), so 13:00 Phoenix = 20:00 UTC.
//   The conflict test seeds a busy slot at 2026-08-04T20:00:00Z–21:00:00Z (13:00–14:00 Phoenix).
//   A newly created 13:00–14:00 Phoenix appointment for the same crew will overlap and be rejected.
// ---------------------------------------------------------------------------

/**
 * Clicks a week column at the given y offset from the column's top edge.
 * Uses dispatchEvent rather than .click() so the event is delivered directly to
 * the column div, bypassing hit-testing. This avoids accumulated appt-block
 * buttons (stopPropagation) intercepting the click on a shared e2e DB.
 */
async function clickWeekCol(page: import("@playwright/test").Page, date: string, offsetY: number) {
  const col = page.locator(`[data-testid="week-col-${date}"]`);
  await expect(col).toBeVisible();
  const box = await col.boundingBox();
  if (!box) throw new Error(`week-col-${date} has no bounding box`);
  // Dispatch synthetic click directly to the column element with realistic clientY.
  await col.dispatchEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX: box.x + 20,
    clientY: box.y + offsetY,
  });
}

test("create: click an empty Week slot -> pick a job -> appointment is created", async ({ page }) => {
  const uniq = `Createtest ${Date.now()}`;
  const { jobId } = await seedJob(uniq, "11 Create Way");

  await page.goto(`/schedule?view=week&anchor=${ANCHOR}`);
  // y=280 -> minutesFromOffset(280, 560) = 780 = 13:00 local (America/Phoenix).
  // dispatchEvent delivers directly to the column div, bypassing child appt-block
  // buttons' stopPropagation (accumulated from prior test runs on shared e2e DB).
  await clickWeekCol(page, "2026-08-04", 280);

  await expect(page.getByTestId("create-appt-form")).toBeVisible();

  // Type the unique customer name (need >= 2 chars to trigger search)
  const searchInput = page.getByTestId("create-job-search");
  await searchInput.fill(uniq);

  // Wait for typeahead results to appear (server action fires on keystroke)
  const firstOption = page.getByTestId("create-job-option").first();
  await expect(firstOption).toBeVisible({ timeout: 10_000 });
  await firstOption.click();

  // No crew selected (Unassigned) — should always succeed
  await page.getByTestId("create-submit").click();

  // The appointment block with our customer's name should appear.
  // Filter by the full unique name (includes Date.now() suffix) to avoid
  // strict-mode violations from accumulated blocks in prior test runs.
  await expect(
    page.getByTestId("appt-block").filter({ hasText: uniq }),
  ).toBeVisible({ timeout: 10_000 });

  // DB assertion: a scheduled appointment for this job now exists
  const rows = await withTenant(tenantId, (tx) =>
    tx.select().from(appointment).where(
      and(eq(appointment.jobId, jobId), eq(appointment.status, "scheduled")),
    ),
  );
  expect(rows.length).toBeGreaterThan(0);
});

test("create: assigned crew that is busy shows an inline conflict and does not create", async ({ page }) => {
  const uniq = `Conflicttest ${Date.now()}`;
  const { jobId, customerId } = await seedJob(uniq, "22 Conflict Way");

  // Seed a crew user (email is notNull on user table)
  const crewId = await withTenant(tenantId, async (tx) => {
    const [u] = await tx
      .insert(user)
      .values({
        tenantId,
        name: `BusyBee ${Date.now()}`,
        email: `busybee-${Date.now()}@e2e.test`,
        role: "crew",
      })
      .returning();
    return u!.id;
  });

  // Pre-book the crew member at 13:00–14:00 Phoenix on 2026-08-04.
  // America/Phoenix is UTC-7 (no DST), so 13:00 = 20:00 UTC.
  // The clicked y=280 also resolves to 13:00 Phoenix (minutesFromOffset(280,560)=780).
  await bookAppointment({
    tenantId,
    jobId,
    customerId,
    type: "inspection",
    assigneeUserId: crewId,
    startsAt: new Date("2026-08-04T20:00:00Z"),
    endsAt: new Date("2026-08-04T21:00:00Z"),
  });

  await page.goto(`/schedule?view=week&anchor=${ANCHOR}`);
  await clickWeekCol(page, "2026-08-04", 280);
  await page.getByTestId("create-appt-form").waitFor();

  // Fill job search
  await page.getByTestId("create-job-search").fill(uniq);
  await expect(page.getByTestId("create-job-option").first()).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("create-job-option").first().click();

  // Select the busy crew member
  await page.getByTestId("create-crew").selectOption(crewId);

  await page.getByTestId("create-submit").click();

  // Conflict message appears and the form stays open
  await expect(page.getByText(/taken for this crew/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("create-appt-form")).toBeVisible();
});

test("create: crew install surfaces recommended slots and books the chosen one", async ({ page }) => {
  const uniq = `Crewslot ${Date.now()}`;
  const { jobId } = await seedJob(uniq, "44 Crew Way");
  // A crew install is assigned to a crew ENTITY (not an individual user).
  const crewEntityId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx
      .insert(crew)
      .values({ tenantId, name: `Install Crew ${Date.now()}` })
      .returning();
    return c!.id;
  });

  await page.goto(`/schedule?view=week&anchor=${ANCHOR}`);
  await clickWeekCol(page, "2026-08-04", 200);
  await page.getByTestId("create-appt-form").waitFor();

  await page.getByTestId("create-job-search").fill(uniq);
  await expect(page.getByTestId("create-job-option").first()).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("create-job-option").first().click();

  // Choose a crew install + a crew entity → recommended crew slots should appear.
  await page.getByTestId("create-type").selectOption("crew");
  await page.getByTestId("create-crew-entity").selectOption(crewEntityId);

  const firstSlot = page.getByTestId("crew-slot-option").first();
  await expect(firstSlot).toBeVisible({ timeout: 10_000 });
  await firstSlot.click();

  await page.getByTestId("create-submit").click();

  // Form closes on success; a scheduled crew appointment for this job now exists.
  await expect(page.getByTestId("create-appt-form")).toBeHidden({ timeout: 10_000 });
  const start = Date.now();
  let booked = false;
  while (Date.now() - start < 10_000) {
    const rows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(appointment)
        .where(and(eq(appointment.jobId, jobId), eq(appointment.type, "crew"), eq(appointment.status, "scheduled"))),
    );
    if (rows.length > 0) { booked = true; break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  expect(booked).toBe(true);
});

test("create: unassigned appointment always succeeds", async ({ page }) => {
  const uniq = `Unassigned ${Date.now()}`;
  await seedJob(uniq, "33 Open Way");

  await page.goto(`/schedule?view=week&anchor=${ANCHOR}`);
  // y=200 -> minutesFromOffset(200, 560) = snap30(360 + (200/560)*840) ≈ snap30(660) = 660 = 11:00 local.
  await clickWeekCol(page, "2026-08-05", 200);
  await page.getByTestId("create-appt-form").waitFor();
  await page.getByTestId("create-job-search").fill(uniq);
  await expect(page.getByTestId("create-job-option").first()).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("create-job-option").first().click();

  // Leave crew as Unassigned (default)
  await page.getByTestId("create-submit").click();

  // Filter by full unique name to avoid strict-mode violations from accumulated blocks.
  await expect(
    page.getByTestId("appt-block").filter({ hasText: uniq }),
  ).toBeVisible({ timeout: 10_000 });
});
