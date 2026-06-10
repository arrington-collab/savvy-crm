import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, communication, eq } from "@savvy/db";

const { id: tenantId, key } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 500));
  }
}

test("lead intake: form -> workflow -> booking SMS logged with slot-picker link", async ({
  page,
}) => {
  // 1. Submit the public lead form for the e2e tenant.
  await page.goto(`/intake/${key}`);
  await page.fill('input[name="name"]', "E2E Jane");
  await page.fill('input[name="phone"]', "+15555551234");
  await page.fill('input[name="address"]', "742 Evergreen Terrace");
  await page.click('button[type="submit"]');
  await expect(page.getByTestId("intake-success")).toBeVisible();

  // 2. The lead.intake workflow runs (AI qualify + SMS) -> communication logged
  //    with the signed slot-picker booking link (/book/<token>).
  const sms = await waitFor(async () => {
    const rows = await adminDb.select().from(communication).where(eq(communication.tenantId, tenantId));
    return rows.find((r) => r.channel === "sms" && (r.body ?? "").includes("/book/"));
  });
  expect(sms.body ?? "").toContain("/book/");

  // 3. The booking link is a signed token URL pointing at the slot picker.
  const bookUrl = (sms.body ?? "").match(/https?:\/\/[^\s]+\/book\/[^\s]+/)?.[0];
  expect(bookUrl).toBeTruthy();

  // full slot-pick -> appointment booking covered by scheduling.spec.ts (Task 20);
  // the slot-picker UI page is built in Task 16, so this spec stops at the
  // lead-intake -> booking-SMS stage.
});
