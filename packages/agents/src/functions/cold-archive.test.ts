/**
 * Tests for archiveOldDocuments helper.
 *
 * Live DB test: seeds a tenant + two docs (one 120d old, one today),
 * calls archiveOldDocuments with a 90d cutoff, and asserts only the
 * old doc gets archivedAt set.
 *
 * Run with:
 *   DATABASE_URL=... DATABASE_ADMIN_URL=... pnpm test cold-archive
 */
import { describe, it, expect } from "vitest";
import { adminDb, document, tenant, withTenant, eq, isNull } from "@savvy/db";
import { archiveOldDocuments } from "./cold-archive";

async function makeArchiveTenant(): Promise<{ tenantId: string }> {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "ArchiveTest", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  return { tenantId: t!.id };
}

describe("archiveOldDocuments", () => {
  it("archives docs older than cutoff, leaves recent ones untouched", async () => {
    const { tenantId } = await makeArchiveTenant();

    const now = new Date();
    const oldDate = new Date(now.getTime() - 120 * 86_400_000); // 120 days ago
    const cutoff = new Date(now.getTime() - 90 * 86_400_000);   // 90 days ago

    // Seed old doc (should be archived)
    const [oldDoc] = await adminDb.insert(document).values({
      tenantId,
      kind: "photo",
      r2Key: `old-${crypto.randomUUID()}`,
      sizeBytes: 1000,
      createdAt: oldDate,
    }).returning();

    // Seed recent doc (should NOT be archived)
    const [recentDoc] = await adminDb.insert(document).values({
      tenantId,
      kind: "photo",
      r2Key: `recent-${crypto.randomUUID()}`,
      sizeBytes: 500,
      createdAt: now,
    }).returning();

    // Call archiveOldDocuments
    const count = await archiveOldDocuments(tenantId, cutoff);
    expect(count).toBe(1);

    // Verify old doc has archivedAt set
    const [archived] = await withTenant(tenantId, (tx) =>
      tx.select().from(document).where(eq(document.id, oldDoc!.id)),
    );
    expect(archived!.archivedAt).not.toBeNull();

    // Verify recent doc still has archivedAt = null
    const [recent] = await withTenant(tenantId, (tx) =>
      tx.select().from(document).where(eq(document.id, recentDoc!.id)),
    );
    expect(recent!.archivedAt).toBeNull();
  });

  it("is idempotent — re-running does not double-count already-archived docs", async () => {
    const { tenantId } = await makeArchiveTenant();

    const oldDate = new Date(Date.now() - 120 * 86_400_000);
    const cutoff = new Date(Date.now() - 90 * 86_400_000);

    await adminDb.insert(document).values({
      tenantId,
      kind: "photo",
      r2Key: `idem-${crypto.randomUUID()}`,
      sizeBytes: 1000,
      createdAt: oldDate,
    });

    const first = await archiveOldDocuments(tenantId, cutoff);
    const second = await archiveOldDocuments(tenantId, cutoff); // already archived
    expect(first).toBe(1);
    expect(second).toBe(0); // isNull filter excludes already-archived
  });
});
