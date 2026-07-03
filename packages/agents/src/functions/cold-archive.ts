import { adminDb, withTenant, document, tenant, and, isNull, sql, lt } from "@savvy/db";
import { tenantsDueAtHour } from "@savvy/core";
import { inngest } from "../client";

const ARCHIVE_AFTER_DAYS = 90;

export async function archiveOldDocuments(tenantId: string, cutoff: Date): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const res = await tx.update(document).set({ archivedAt: sql`now()` })
      .where(and(isNull(document.archivedAt), lt(document.createdAt, cutoff)))
      .returning({ id: document.id });
    return res.length;
  });
}

export const coldArchiveDocuments = inngest.createFunction(
  { id: "cold-archive-documents", concurrency: { limit: 1 } },
  { cron: "0 * * * *" }, // hourly tick; runs each tenant at 04:00 its local time
  async ({ step }) => {
    const cutoff = await step.run("cutoff", async () => new Date(Date.now() - ARCHIVE_AFTER_DAYS * 86_400_000));
    const due = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
      return tenantsDueAtHour(rows, new Date(), 4).map((t) => t.id);
    });
    let archived = 0;
    for (const id of due) {
      // step.run serialises return values through JSON — re-hydrate cutoff date after round-trip
      archived += await step.run(`archive-${id}`, () =>
        archiveOldDocuments(id, new Date(cutoff as unknown as string)),
      );
    }
    return { archived };
  },
);
