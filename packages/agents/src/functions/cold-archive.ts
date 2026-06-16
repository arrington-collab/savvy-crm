import { adminDb, withTenant, document, tenant, and, isNull, sql, lt } from "@savvy/db";
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
  { cron: "TZ=America/Phoenix 0 4 * * *" }, // daily 04:00
  async ({ step }) => {
    const cutoff = await step.run("cutoff", async () => new Date(Date.now() - ARCHIVE_AFTER_DAYS * 86_400_000));
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    let archived = 0;
    for (const t of tenants) {
      // step.run serialises return values through JSON — re-hydrate cutoff date after round-trip
      archived += await step.run(`archive-${t.id}`, () =>
        archiveOldDocuments(t.id, new Date(cutoff as unknown as string)),
      );
    }
    return { archived };
  },
);
