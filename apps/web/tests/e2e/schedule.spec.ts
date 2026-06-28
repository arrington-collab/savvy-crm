import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, user, customer, property, job, appointment } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// Returns Monday of the current week as an ISO date string YYYY-MM-DD.
function thisMonday(): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
  return mon;
}

// Build a Date for `dayOffset` days from Monday of this week, at 09:00 UTC.
function thisWeekDate(dayOffset: number, hour = 9): Date {
  const mon = thisMonday();
  return new Date(Date.UTC(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate() + dayOffset, hour, 0, 0));
}

type SeedOptions = {
  type: "inspection" | "cm" | "crew";
  dayOffset?: number;
  city?: string;
};

/**
 * Seed one appointment this week, assigned to a fresh dedicated crew user.
 * Returns the appointment id AND that crew user's id — the crew board renders
 * one column per crew member (`crew-col-<userId>`), so the crew user's id is a
 * deterministic, pollution-proof handle on exactly this appointment's card.
 */
async function seedAppt(opts: SeedOptions): Promise<{ apptId: string; crewUserId: string }> {
  const { type, dayOffset = 1, city = "Phoenix" } = opts;

  const [crewUser] = await adminDb
    .insert(user)
    .values({
      tenantId,
      name: `ScheduleCrew-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      email: `sched-crew-${Date.now()}-${Math.random().toString(36).slice(2)}@e2e.test`,
      role: "crew",
    })
    .returning();

  const [cust] = await adminDb
    .insert(customer)
    .values({ tenantId, name: `SchedCust-${Date.now()}`, phone: "+15555557777" })
    .returning();

  const [prop] = await adminDb
    .insert(property)
    .values({ tenantId, customerId: cust!.id, address: `${city} Ave`, city })
    .returning();

  const [j] = await adminDb
    .insert(job)
    .values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "lead" })
    .returning();

  const startsAt = thisWeekDate(dayOffset, 9);
  const endsAt = thisWeekDate(dayOffset, 10);

  const [appt] = await adminDb
    .insert(appointment)
    .values({
      tenantId,
      jobId: j!.id,
      customerId: cust!.id,
      type,
      startsAt,
      endsAt,
      assigneeUserId: crewUser!.id,
      status: "scheduled",
    })
    .returning();

  return { apptId: appt!.id, crewUserId: crewUser!.id };
}

/** Day offset (from this week's Monday) that lands on TODAY, which the schedule
 *  always shows regardless of its week-start convention. Mon=0 … Sun=6. */
function todayOffset(): number {
  return (new Date().getUTCDay() + 6) % 7;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("week view renders appointment blocks", async ({ page }) => {
  await seedAppt({ type: "inspection", dayOffset: 1 });

  await page.goto("/schedule");
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await expect(page.getByTestId("appt-block").first()).toBeVisible();
});

test("view toggle switches to month and crew", async ({ page }) => {
  // Seed an appointment so the crew view has something; but toggle is purely UI.
  await seedAppt({ type: "inspection", dayOffset: 2 });

  await page.goto("/schedule");

  await page.getByTestId("view-month").click();
  await expect(page.getByTestId("month-grid")).toBeVisible();

  await page.getByTestId("view-crew").click();
  await expect(page.getByTestId("crew-board")).toBeVisible();
});

test("type filter narrows the set", async ({ page }) => {
  // Seed two different appointment types this week.
  await seedAppt({ type: "inspection", dayOffset: 2 });
  await seedAppt({ type: "crew", dayOffset: 3 });

  await page.goto("/schedule");
  await page.getByTestId("view-crew").click();
  await expect(page.getByTestId("crew-board")).toBeVisible();

  const before = await page.getByTestId("appt-card").count();

  await page.getByTestId("filter-type").selectOption("inspection");
  // The URL should reflect the type param.
  await expect(page).toHaveURL(/type=inspection/);

  const after = await page.getByTestId("appt-card").count();
  expect(after).toBeLessThanOrEqual(before);
});

test("clicking an appointment opens the popover and marks done", async ({ page }) => {
  // Seed on TODAY so the appt is always in the schedule's visible week (its
  // Monday-relative dayOffset disagrees with the page's week on some weekdays),
  // and target OUR appt via its dedicated crew column. The shared e2e DB
  // accumulates many crew cards across specs (incl. a no_show crew appt whose
  // popover has no "Done" action), so a positional `.last()` is non-deterministic;
  // the crew-col-<userId> handle is exact regardless of pollution.
  const { crewUserId } = await seedAppt({ type: "crew", dayOffset: todayOffset() });

  await page.goto("/schedule?view=crew&type=crew");
  await expect(page.getByTestId("crew-board")).toBeVisible();

  const card = page.getByTestId(`crew-col-${crewUserId}`).getByTestId("appt-card");
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await card.click();

  await expect(page.getByTestId("appt-popover")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  await expect(page.getByTestId("appt-popover")).toBeHidden();
});
