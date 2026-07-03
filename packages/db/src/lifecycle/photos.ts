import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { property, job } from "../schema/index";
import { tenant } from "../schema/index";
import { eq, desc, sql } from "drizzle-orm";
import { normalizeAddressForMatch } from "@savvy/core";

const CLOSED_STAGES = ["complete", "lost"] as const;

/** Resolve the Savvy job a photo belongs to by matching its property address.
 *  Prefers the most recent open (non-complete/lost) job; else the newest job. */
export async function resolvePhotoJob(input: { tenantId: string; address: string }): Promise<{ jobId: string } | null> {
  const norm = normalizeAddressForMatch(input.address);
  return withTenant(input.tenantId, async (tx) => {
    // Normalize property addresses in SQL the same way (lower + strip . , # + collapse spaces).
    // Suffix-word standardization is not reproduced in SQL; we compare on the cleaned form and
    // rely on normalizeAddressForMatch-equal inputs. Fetch candidates, then match in JS for parity.
    const props = await tx.select({ id: property.id, address: property.address }).from(property);
    const match = props.find((p) => normalizeAddressForMatch(p.address) === norm);
    if (!match) return null;
    const jobs = await tx.select({ id: job.id, stage: job.stage, createdAt: job.createdAt })
      .from(job).where(eq(job.propertyId, match.id)).orderBy(desc(job.createdAt));
    if (jobs.length === 0) return null;
    const open = jobs.find((j) => !CLOSED_STAGES.includes(j.stage as (typeof CLOSED_STAGES)[number]));
    return { jobId: (open ?? jobs[0]!).id };
  });
}

/** Resolve a tenant by its SiteSnap ingestion key (settings.sitesnap.ingestKey). Admin path. */
export async function resolveTenantByIngestKey(key: string): Promise<{ tenantId: string } | null> {
  if (!key) return null;
  const [row] = await adminDb.select({ id: tenant.id })
    .from(tenant)
    .where(sql`${tenant.settings} #>> '{sitesnap,ingestKey}' = ${key}`);
  return row ? { tenantId: row.id } : null;
}
