import { and, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  partnerKey,
  partnerClassForSource,
  partnerRefFromSourceDetail,
  PARTNER_SOURCE_VALUES,
  type PartnerClass,
} from "@savvy/core";
import { withTenant, type Tx } from "../tenant";
import { partner, partnerMergeCandidate } from "../schema/partner";
import { lead } from "../schema/crm";

export type PartnerInput = { name: string; org?: string | null; class?: PartnerClass };

/**
 * Create-once inside an existing tenant transaction. Identity is the folded
 * normalized_key; a concurrent insert loses to the unique index and re-selects.
 * A newly created partner whose folded NAME matches an existing partner at a
 * different org gets a pending merge candidate — surfaced for a human, never
 * auto-merged.
 */
export async function findOrCreatePartnerTx(
  tx: Tx,
  tenantId: string,
  input: PartnerInput,
): Promise<{ id: string; created: boolean }> {
  const key = partnerKey(input.name, input.org);
  const [existing] = await tx.select({ id: partner.id }).from(partner)
    .where(and(eq(partner.tenantId, tenantId), eq(partner.normalizedKey, key)));
  if (existing) return { id: existing.id, created: false };

  const [row] = await tx.insert(partner).values({
    tenantId,
    name: input.name.trim(),
    org: input.org?.trim() || null,
    class: input.class ?? "other",
    normalizedKey: key,
  }).onConflictDoNothing().returning();

  if (!row) {
    const [raced] = await tx.select({ id: partner.id }).from(partner)
      .where(and(eq(partner.tenantId, tenantId), eq(partner.normalizedKey, key)));
    return { id: raced!.id, created: false };
  }

  await noteMergeCandidates(tx, tenantId, { id: row.id, name: row.name, org: row.org, normalizedKey: row.normalizedKey });
  return { id: row.id, created: true };
}

export async function findOrCreatePartner(tenantId: string, input: PartnerInput): Promise<{ id: string; created: boolean }> {
  return withTenant(tenantId, (tx) => findOrCreatePartnerTx(tx, tenantId, input));
}

async function noteMergeCandidates(
  tx: Tx,
  tenantId: string,
  created: { id: string; name: string; org: string | null; normalizedKey: string },
): Promise<void> {
  const namePart = created.normalizedKey.split("|")[0];
  if (!namePart) return;
  const dups = await tx.select({ id: partner.id, org: partner.org }).from(partner).where(and(
    eq(partner.tenantId, tenantId),
    ne(partner.id, created.id),
    eq(partner.status, "active"),
    eq(sql`split_part(${partner.normalizedKey}, '|', 1)`, namePart),
  ));
  for (const d of dups) {
    await tx.insert(partnerMergeCandidate).values({
      tenantId,
      partnerAId: d.id, // older record is the keep-default
      partnerBId: created.id,
      reason: `Same name "${created.name}" at different orgs (${d.org ?? "no org"} vs ${created.org ?? "no org"})`,
    }).onConflictDoNothing();
  }
}

/** Typeahead: active partners matching a name/org fragment, tenant-scoped. */
export async function searchPartners(
  tenantId: string,
  query: string,
): Promise<Array<{ id: string; name: string; org: string | null; class: string }>> {
  const q = query.trim();
  if (!q) return [];
  const like = `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return withTenant(tenantId, (tx) =>
    tx.select({ id: partner.id, name: partner.name, org: partner.org, class: partner.class })
      .from(partner)
      .where(and(
        eq(partner.tenantId, tenantId),
        eq(partner.status, "active"),
        or(ilike(partner.name, like), ilike(partner.org, like)),
      ))
      .orderBy(partner.name)
      .limit(10),
  );
}

/**
 * One-time (and self-healing) backfill: normalize legacy free-text
 * source_detail on partner-class leads into partner records and stamp
 * lead.partner_id. Unattributable leads (no name in the detail) are skipped —
 * they surface in the partner.attribution evidence check, not guessed at.
 */
export async function backfillPartnerAttribution(
  tenantId: string,
): Promise<{ attributed: number; skipped: number }> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select({ id: lead.id, source: lead.source, sourceDetail: lead.sourceDetail })
      .from(lead)
      .where(and(
        eq(lead.tenantId, tenantId),
        inArray(lead.source, [...PARTNER_SOURCE_VALUES]),
        isNull(lead.partnerId),
      ));
    let attributed = 0;
    let skipped = 0;
    for (const r of rows) {
      const ref = partnerRefFromSourceDetail(r.source ?? "", r.sourceDetail);
      if (!ref) {
        skipped++;
        continue;
      }
      const { id } = await findOrCreatePartnerTx(tx, tenantId, { ...ref, class: partnerClassForSource(r.source ?? "") });
      await tx.update(lead).set({ partnerId: id }).where(eq(lead.id, r.id));
      attributed++;
    }
    return { attributed, skipped };
  });
}

/** Pending merge proposals for the review card. */
export async function listPartnerMergeCandidates(tenantId: string): Promise<Array<{
  id: string;
  reason: string;
  partnerA: { id: string; name: string; org: string | null };
  partnerB: { id: string; name: string; org: string | null };
}>> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select().from(partnerMergeCandidate)
      .where(and(eq(partnerMergeCandidate.tenantId, tenantId), eq(partnerMergeCandidate.status, "pending")));
    const out = [] as Array<{ id: string; reason: string; partnerA: { id: string; name: string; org: string | null }; partnerB: { id: string; name: string; org: string | null } }>;
    for (const c of rows) {
      const [pa] = await tx.select({ id: partner.id, name: partner.name, org: partner.org }).from(partner).where(eq(partner.id, c.partnerAId));
      const [pb] = await tx.select({ id: partner.id, name: partner.name, org: partner.org }).from(partner).where(eq(partner.id, c.partnerBId));
      if (pa && pb) out.push({ id: c.id, reason: c.reason, partnerA: pa, partnerB: pb });
    }
    return out;
  });
}

/**
 * Human decision on a proposed merge. merge: repoint partner B's leads to A and
 * archive B. keep_separate: both stay active. Idempotent — a non-pending
 * candidate is a no-op.
 */
export async function resolveMergeCandidate(
  tenantId: string,
  input: { candidateId: string; action: "merge" | "keep_separate" },
): Promise<{ resolved: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const [cand] = await tx.select().from(partnerMergeCandidate)
      .where(and(eq(partnerMergeCandidate.tenantId, tenantId), eq(partnerMergeCandidate.id, input.candidateId)));
    if (!cand || cand.status !== "pending") return { resolved: false };

    if (input.action === "merge") {
      await tx.update(lead).set({ partnerId: cand.partnerAId })
        .where(and(eq(lead.tenantId, tenantId), eq(lead.partnerId, cand.partnerBId)));
      await tx.update(partner).set({ status: "archived" }).where(eq(partner.id, cand.partnerBId));
      await tx.update(partnerMergeCandidate).set({ status: "merged" }).where(eq(partnerMergeCandidate.id, cand.id));
    } else {
      await tx.update(partnerMergeCandidate).set({ status: "kept_separate" }).where(eq(partnerMergeCandidate.id, cand.id));
    }
    return { resolved: true };
  });
}
