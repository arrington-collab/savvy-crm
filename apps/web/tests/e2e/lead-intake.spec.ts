import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, communication, job, eq } from "@savvy/db";

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

test("lead intake: form -> workflow -> sms logged -> job on pipeline -> dashboard", async ({
  page,
  request,
}) => {
  // 1. Submit the public lead form for the e2e tenant.
  await page.goto(`/intake/${key}`);
  await page.fill('input[name="name"]', "E2E Jane");
  await page.fill('input[name="phone"]', "+15555551234");
  await page.fill('input[name="address"]', "742 Evergreen Terrace");
  await page.click('button[type="submit"]');
  await expect(page.getByTestId("intake-success")).toBeVisible();

  // 2. The lead.intake workflow runs (AI qualify + SMS) -> communication logged.
  const sms = await waitFor(async () => {
    const rows = await adminDb.select().from(communication).where(eq(communication.tenantId, tenantId));
    return rows.find((r) => r.channel === "sms" && (r.body ?? "").includes("/api/leads/"));
  });
  expect(sms.body ?? "").toContain("/book");

  // 3. Click the booking link -> lead.booked workflow creates appointment + job.
  const bookUrl = (sms.body ?? "").match(/http:\/\/[^\s]+\/book/)?.[0];
  expect(bookUrl).toBeTruthy();
  const res = await request.get(bookUrl!);
  expect(res.ok()).toBeTruthy();

  // 4. A job appears for this tenant at stage "inspected".
  const newJob = await waitFor(async () => {
    const rows = await adminDb.select().from(job).where(eq(job.tenantId, tenantId));
    return rows.find((j) => j.stage === "inspected");
  });
  expect(newJob.stage).toBe("inspected");

  // 5. The dashboard (tenant-scoped to this e2e tenant) reflects the new job.
  await page.goto("/dashboard");
  await expect(page.getByTestId("stage-inspected")).toContainText("1");
  await expect(page.getByTestId("metric-total")).toContainText("1");
});
