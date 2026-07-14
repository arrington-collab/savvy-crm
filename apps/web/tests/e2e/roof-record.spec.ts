import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb, withTenant, customer, property, lead, document, user, eq,
  startInspectionForLead, ingestInspectionMedia, completeInspection,
  addInspectionFinding, setInspectionZoneGrade, applyFriendRule,
  approveInspection, publishInspection, setInspectionNarrative,
  ensureInspectionChecklists, ensureRecordLink,
  inspectionFinding, and, isNull,
} from "@savvy/db";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;

async function seedPublishedRecord(stamp: string, opts: { healthy: boolean }) {
  await ensureInspectionChecklists(tenantId);
  const ids = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `Record-${stamp}`, phone: "+15555559933" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Record Rd`, city: "Phoenix", state: "AZ", yearBuilt: 2018 }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified" }).returning();
    return { customerId: c!.id, propertyId: p!.id, leadId: l!.id };
  });
  const [u] = await adminDb.insert(user).values({
    tenantId, clerkUserId: `clk-rec-${stamp}`, name: "Ida Inspector", email: `ida-rec-${stamp}@test.local`, role: "admin",
  }).returning();

  const started = await startInspectionForLead({ tenantId, leadId: ids.leadId });
  if ("error" in started) throw new Error("start failed");
  const inspectionId = started.inspectionId;

  async function landZone(zoneKey: string, zoneLabel: string, zoneKind: string) {
    const [d] = await adminDb.insert(document).values({
      tenantId, leadId: ids.leadId, kind: "photo", source: "sitesnap",
      sitesnapPhotoId: `ss-${stamp}-${zoneKey}`, qcStatus: "passed",
    }).returning();
    const media = await ingestInspectionMedia({ tenantId, inspectionId, zoneKey, zoneLabel, zoneKind, documentId: d!.id });
    if ("error" in media) throw new Error("media failed");
    return { docId: d!.id, zoneId: media.inspectionZoneId };
  }

  const north = await landZone("north_slope", "North slope", "facet");
  const gutters = await landZone("gutters", "Gutters", "gutters");

  if (!opts.healthy) {
    await addInspectionFinding({
      tenantId, inspectionZoneId: north.zoneId,
      whatItIs: "Sealant bond failed on the field shingles", ifIgnored: "Wind can lift unsealed shingles",
      timeframe: "Before the next storm season", photoIds: [north.docId], createdBy: "inspector",
      disposition: "repair_quoted", repairEstimateCents: 42000,
    });
    const hangers = await addInspectionFinding({
      tenantId, inspectionZoneId: gutters.zoneId,
      whatItIs: "Two loose gutter hangers, resecured", photoIds: [gutters.docId], createdBy: "inspector",
      checklistItemKey: "gutter_pitch", repairEstimateCents: 9000,
    });
    if ("error" in hangers) throw new Error("finding failed");
    await applyFriendRule({ tenantId, findingId: hangers.findingId });
    await setInspectionZoneGrade({ tenantId, inspectionZoneId: north.zoneId, grade: "action", userId: u!.id });
    await setInspectionZoneGrade({ tenantId, inspectionZoneId: gutters.zoneId, grade: "good", userId: u!.id });
  } else {
    await setInspectionZoneGrade({ tenantId, inspectionZoneId: north.zoneId, grade: "good", userId: u!.id });
    await setInspectionZoneGrade({ tenantId, inspectionZoneId: gutters.zoneId, grade: "good", userId: u!.id });
  }

  await completeInspection({ tenantId, inspectionId });
  // Clear any pipe-suggested unconfirmed findings so approval unblocks.
  await adminDb.delete(inspectionFinding).where(and(eq(inspectionFinding.tenantId, tenantId), isNull(inspectionFinding.confirmedAt)));
  await setInspectionNarrative({ tenantId, inspectionId, narrative: "An honest, plain-English roof story.", source: "ai" });
  await approveInspection({ tenantId, inspectionId, userId: u!.id });
  await publishInspection({ tenantId, inspectionId });
  const { code } = await ensureRecordLink({ tenantId, inspectionId });
  return { code, inspectionId };
}

test("Roof Record: action-grade rendering + zone tap flow + friend rule + baseline", async ({ page }) => {
  const stamp = Date.now().toString(36);
  const { code } = await seedPublishedRecord(stamp, { healthy: false });

  await page.goto(`/record/${code}`);
  await expect(page.getByTestId("record-page")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("record-address")).toContainText("Record Rd");
  await expect(page.getByTestId("record-narrative")).toContainText("honest, plain-English");
  await expect(page.getByTestId("healthy-roof")).toHaveCount(0);

  // Zone tap flow: the action zone opens with its finding in plain English + the photo.
  await page.getByTestId("zone-row-north_slope").click();
  const detail = page.getByTestId("zone-detail-north_slope");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Sealant bond failed");
  await expect(detail).toContainText("If left alone");
  await expect(detail).toContainText("Before the next storm season");

  // Friend rule, verbatim phrase + the comped item.
  await expect(page.getByTestId("free-repairs")).toContainText("anything we'd do for a friend or neighbor is free");
  await expect(page.getByTestId("free-repairs")).toContainText("loose gutter hangers");

  // Suggestions: quoted repair with honest price; NO replacement talk (no replacement_factor).
  await expect(page.getByTestId("suggestions")).toContainText("$420");
  await expect(page.getByTestId("replacement-discussion")).toHaveCount(0);
  await expect(page.getByTestId("credit-terms")).toContainText("within 3 years");

  // Age + the moat sentence.
  await expect(page.getByTestId("age-range")).toContainText("original roof — built 2018");
  await expect(page.getByTestId("baseline-statement")).toContainText("this baseline protects your claim");
});

test("Roof Record: the healthy roof is a first-class celebration", async ({ page }) => {
  const stamp = `${Date.now().toString(36)}h`;
  const { code } = await seedPublishedRecord(stamp, { healthy: true });

  await page.goto(`/record/${code}`);
  await expect(page.getByTestId("record-page")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("healthy-roof")).toBeVisible();
  await expect(page.getByTestId("healthy-roof")).toContainText("Healthy roof.");
  await expect(page.getByTestId("healthy-roof")).toContainText("after the next major storm");
  await expect(page.getByTestId("suggestions")).toHaveCount(0);
  await expect(page.getByTestId("free-repairs")).toHaveCount(0);
});

test("RED PATH: an unpublished Record never renders", async ({ page }) => {
  const stamp = `${Date.now().toString(36)}u`;
  await ensureInspectionChecklists(tenantId);
  const ids = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `Unpub-${stamp}` }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Unpub Way` }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "web" }).returning();
    return { leadId: l!.id };
  });
  const started = await startInspectionForLead({ tenantId, leadId: ids.leadId });
  if ("error" in started) throw new Error("start failed");
  const { code } = await ensureRecordLink({ tenantId, inspectionId: started.inspectionId });

  await page.goto(`/record/${code}`);
  await expect(page.getByTestId("record-invalid")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("record-page")).toHaveCount(0);
});
