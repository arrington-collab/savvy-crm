import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, user, customer, property, job, appointment } from "@savvy/db";
import { toCivilDate } from "@savvy/core";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

const TZ = "America/Phoenix";

// Returns Monday of the current week (UTC midnight).
function thisMonday(): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
}

// Build a Date `dayOffset` days from Monday of this week at the given UTC hour.
function thisWeekDate(dayOffset: number, hour = 9): Date {
  const mon = thisMonday();
  return new Date(Date.UTC(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate() + dayOffset, hour, 0, 0));
}

// Seed one crew user and return their id.
async function seedCrewUser(label: string): Promise<string> {
  const [u] = await adminDb
    .insert(user)
    .values({
      tenantId,
      name: `${label}-${Date.now()}`,
      email: `drag-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@e2e.test`,
      role: "crew",
    })
    .returning();
  return u!.id;
}

// Seed one appointment assigned to `assigneeUserId`; returns { apptId, startsAt }.
async function seedAppt(opts: {
  assigneeUserId: string;
  dayOffset?: number;
  startHour?: number;
  endHour?: number;
}): Promise<{ apptId: string; startsAt: Date; custName: string }> {
  const { assigneeUserId, dayOffset = 1, startHour = 9, endHour = 10 } = opts;

  const custName = `DragCust-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [cust] = await adminDb
    .insert(customer)
    .values({ tenantId, name: custName, phone: "+15555551234" })
    .returning();

  const [prop] = await adminDb
    .insert(property)
    .values({ tenantId, customerId: cust!.id, address: "123 Drag Ave", city: "Phoenix" })
    .returning();

  const [j] = await adminDb
    .insert(job)
    .values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "lead" })
    .returning();

  const startsAt = thisWeekDate(dayOffset, startHour);
  const endsAt = thisWeekDate(dayOffset, endHour);

  const [appt] = await adminDb
    .insert(appointment)
    .values({
      tenantId,
      jobId: j!.id,
      customerId: cust!.id,
      type: "crew",
      startsAt,
      endsAt,
      assigneeUserId,
      status: "scheduled",
    })
    .returning();

  return { apptId: appt!.id, startsAt, custName };
}

// ---------------------------------------------------------------------------
// Helpers for drag
// ---------------------------------------------------------------------------

/** dnd-kit uses PointerSensor (not HTML5 drag events). We must use page.mouse pointer events
 *  with enough intermediate moves to exceed the activationConstraint distance of 5px. */
async function dragToTarget(
  page: import("@playwright/test").Page,
  source: import("@playwright/test").Locator,
  target: import("@playwright/test").Locator,
) {
  // page.mouse.* does NOT auto-scroll like locator.click() — a source below the
  // fold gets a mousedown at off-viewport coordinates that hits nothing and the
  // drag silently no-ops (bit us in CI where the block rendered at y≈837 in a
  // 720px viewport). Scroll first, then measure.
  await source.scrollIntoViewIfNeeded();
  const srcBox = await source.boundingBox();
  const tgtBox = await target.boundingBox();
  if (!srcBox || !tgtBox) throw new Error("Could not get bounding boxes for drag");
  const vp = page.viewportSize();
  if (vp && (srcBox.y + srcBox.height / 2 > vp.height || tgtBox.y + tgtBox.height / 2 > vp.height)) {
    throw new Error(
      `Drag endpoints off-viewport: src y=${Math.round(srcBox.y)} tgt y=${Math.round(tgtBox.y)} vp=${vp.height}`,
    );
  }

  const sx = srcBox.x + srcBox.width / 2;
  const sy = srcBox.y + srcBox.height / 2;
  const tx = tgtBox.x + tgtBox.width / 2;
  const ty = tgtBox.y + tgtBox.height / 2;

  // Move to source, press, jiggle to trigger the PointerSensor (distance: 5), then glide to target.
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // Small initial jitter to clear the 5px activation threshold
  await page.mouse.move(sx + 6, sy + 1);
  await page.mouse.move(sx + 8, sy + 2);
  // Now glide to target in many small steps so over-detection works
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      sx + 8 + ((tx - sx - 8) * i) / steps,
      sy + 2 + ((ty - sy - 2) * i) / steps,
    );
  }
  // Hover over target briefly so the droppable registers
  await page.waitForTimeout(100);
  await page.mouse.up();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("drag a crew card to another column reassigns it", async ({ page }) => {
  const mikeId = await seedCrewUser("Mike");
  const saraId = await seedCrewUser("Sara");
  const { startsAt } = await seedAppt({ assigneeUserId: mikeId, dayOffset: 1 });

  // Navigate to the schedule for this week so the appointment is visible.
  const anchor = toCivilDate(startsAt.toISOString(), TZ);
  await page.goto(`/schedule?anchor=${anchor}`);
  await page.getByTestId("view-crew").click();
  await expect(page.getByTestId("crew-board")).toBeVisible();

  const mikeCol = page.getByTestId(`crew-col-${mikeId}`);
  const saraCol = page.getByTestId(`crew-col-${saraId}`);

  // Scroll the overflow-x-auto board so both Mike and Sara's columns are in the viewport simultaneously.
  await page.evaluate(([mId, sId]) => {
    const mike = document.querySelector(`[data-testid="crew-col-${mId}"]`) as HTMLElement | null;
    const sara = document.querySelector(`[data-testid="crew-col-${sId}"]`) as HTMLElement | null;
    if (!mike || !sara) return;
    const scrollEl = mike.closest(".overflow-x-auto") as HTMLElement | null;
    if (!scrollEl) { mike.scrollIntoView({ inline: "start" }); return; }
    const mikeLeft = mike.offsetLeft;
    const saraRight = sara.offsetLeft + sara.offsetWidth;
    const midpoint = (mikeLeft + saraRight) / 2;
    scrollEl.scrollLeft = Math.max(0, midpoint - scrollEl.clientWidth / 2);
  }, [mikeId, saraId]);
  await page.waitForTimeout(200);

  const card = mikeCol.getByTestId("appt-card").first();
  await expect(card).toBeVisible();

  await dragToTarget(page, card, saraCol);

  // After reassign + revalidate, the card appears under Sara's column.
  await expect(saraCol.getByTestId("appt-card")).toBeVisible({ timeout: 10_000 });
});

test("dragging onto a busy crew reverts with a toast", async ({ page }) => {
  const mikeId = await seedCrewUser("MikeBusy");
  const saraId = await seedCrewUser("SaraBusy");

  // Both Mike and Sara have an overlapping appointment (9-10 on the same day).
  const { startsAt } = await seedAppt({ assigneeUserId: mikeId, dayOffset: 2, startHour: 9, endHour: 10 });
  await seedAppt({ assigneeUserId: saraId, dayOffset: 2, startHour: 9, endHour: 10 });

  const anchor = toCivilDate(startsAt.toISOString(), TZ);
  await page.goto(`/schedule?anchor=${anchor}`);
  await page.getByTestId("view-crew").click();
  await expect(page.getByTestId("crew-board")).toBeVisible();

  const mikeCol = page.getByTestId(`crew-col-${mikeId}`);
  const saraCol = page.getByTestId(`crew-col-${saraId}`);

  // Confirm both columns exist in the DOM.
  await expect(mikeCol).toBeAttached();
  await expect(saraCol).toBeAttached();
  await expect(mikeCol.getByTestId("appt-card")).toBeAttached();

  // The crew board is overflow-x-auto and may have many columns from accumulated test data.
  // Scroll the overflow container so Mike's card and Sara's column are both within the viewport.
  // Mike and Sara are inserted sequentially so their columns are adjacent in the flex row.
  await page.evaluate(([mId, sId]) => {
    const mike = document.querySelector(`[data-testid="crew-col-${mId}"]`) as HTMLElement | null;
    const sara = document.querySelector(`[data-testid="crew-col-${sId}"]`) as HTMLElement | null;
    if (!mike || !sara) return;
    // Find the scrollable ancestor
    const scrollEl = mike.closest(".overflow-x-auto") as HTMLElement | null;
    if (!scrollEl) { mike.scrollIntoView({ inline: "start" }); return; }
    // Scroll so the midpoint between the two columns is centered in the scrollEl
    const mikeLeft = mike.offsetLeft;
    const saraRight = sara.offsetLeft + sara.offsetWidth;
    const midpoint = (mikeLeft + saraRight) / 2;
    scrollEl.scrollLeft = Math.max(0, midpoint - scrollEl.clientWidth / 2);
  }, [mikeId, saraId]);
  await page.waitForTimeout(200);

  // After scrolling, both columns should have valid viewport coordinates.
  const mikeBox = await mikeCol.boundingBox();
  const saraBox = await saraCol.boundingBox();
  if (!mikeBox || !saraBox) {
    throw new Error(`Columns not in viewport after scroll: mike=${JSON.stringify(mikeBox)} sara=${JSON.stringify(saraBox)}`);
  }

  const card = mikeCol.getByTestId("appt-card").first();
  await dragToTarget(page, card, saraCol);

  // The server returns slot_taken → client reverts and shows a toast.
  await expect(page.getByText(/busy then|reverted/i)).toBeVisible({ timeout: 12_000 });
  // Mike's card is still in his column (optimistic revert).
  await expect(mikeCol.getByTestId("appt-card")).toBeVisible({ timeout: 5_000 });
});

test("drag a week block to another day", async ({ page }) => {
  const userId = await seedCrewUser("WeekDrag");
  const { startsAt, custName } = await seedAppt({ assigneeUserId: userId, dayOffset: 1 });

  const origDate = toCivilDate(startsAt.toISOString(), TZ);
  // Target: dayOffset 3 from Monday (Wednesday) in the same week.
  const targetDate = toCivilDate(thisWeekDate(3, 9).toISOString(), TZ);

  await page.goto(`/schedule?anchor=${origDate}`);
  // Default view is week.
  await expect(page.getByTestId("week-grid")).toBeVisible();

  const origCol = page.getByTestId(`week-col-${origDate}`);
  const targetCol = page.getByTestId(`week-col-${targetDate}`);
  await expect(origCol).toBeVisible();
  await expect(targetCol).toBeVisible();

  // Drag OUR seeded block, not .first() — the shared e2e tenant accumulates other
  // specs' appointments on the same day, and dragging a foreign block can be
  // rejected server-side (slot rules for its assignee).
  const block = origCol.getByTestId("appt-block").filter({ hasText: custName });
  await expect(block).toBeVisible();

  await dragToTarget(page, block, targetCol);

  // After reschedule + revalidate, OUR block appears under the target column
  // (identity-based: any foreign block in the target col must not pass the test).
  await expect(targetCol.getByTestId("appt-block").filter({ hasText: custName })).toBeVisible({
    timeout: 10_000,
  });
});
