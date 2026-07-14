import { and, eq, isNotNull, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { inspectionZone, inspectionFinding } from "../schema/index";

/**
 * Roof Record slice 2 — the honesty machinery.
 *
 * The anti-scare invariant (roof_record.no_unsupported_action): an ACTION grade
 * is structurally impossible without a linked finding carrying at least one
 * photo. AI may SUGGEST findings, but an unconfirmed ai_suggested finding never
 * licenses ACTION and never publishes — the inspector's on-site call decides.
 * "Your roof is fine" is a first-class outcome: GOOD/MONITOR need no findings.
 */

export type AddFindingResult = { findingId: string } | { error: "zone_not_found" };

export async function addInspectionFinding(input: {
  tenantId: string;
  inspectionZoneId: string;
  whatItIs: string;
  ifIgnored?: string | null;
  timeframe?: string | null;
  photoIds?: string[];
  checklistItemKey?: string | null;
  severitySuggested?: string | null;
  disposition?: string;
  repairEstimateCents?: number | null;
  createdBy: "inspector" | "ai_suggested";
}): Promise<AddFindingResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [zone] = await tx.select({ id: inspectionZone.id }).from(inspectionZone)
      .where(eq(inspectionZone.id, input.inspectionZoneId));
    if (!zone) return { error: "zone_not_found" as const };

    const [row] = await tx.insert(inspectionFinding).values({
      tenantId: input.tenantId,
      inspectionZoneId: input.inspectionZoneId,
      whatItIs: input.whatItIs,
      ifIgnored: input.ifIgnored ?? null,
      timeframe: input.timeframe ?? null,
      photoIds: input.photoIds ?? [],
      checklistItemKey: input.checklistItemKey ?? null,
      severitySuggested: input.severitySuggested ?? null,
      disposition: input.disposition ?? "noted",
      repairEstimateCents: input.repairEstimateCents ?? null,
      createdBy: input.createdBy,
      // Inspector findings are the on-site human call — born confirmed.
      // ai_suggested findings stay unconfirmed until the inspector acts.
      confirmedAt: input.createdBy === "inspector" ? new Date() : null,
    }).returning({ id: inspectionFinding.id });
    return { findingId: row!.id };
  });
}

/** The inspector adopts an AI suggestion as their own call. Idempotent. */
export async function confirmInspectionFinding(input: {
  tenantId: string;
  findingId: string;
  userId?: string | null;
}): Promise<{ confirmed: boolean }> {
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx.update(inspectionFinding)
      .set({ confirmedAt: sql`coalesce(${inspectionFinding.confirmedAt}, now())` })
      .where(eq(inspectionFinding.id, input.findingId))
      .returning({ id: inspectionFinding.id });
    return { confirmed: Boolean(row) };
  });
}

/** The inspector rejects an AI suggestion — the row is removed, not archived
 *  (an unconfirmed suggestion is a draft, not a record). */
export async function dismissInspectionFinding(input: {
  tenantId: string;
  findingId: string;
}): Promise<{ dismissed: boolean }> {
  return withTenant(input.tenantId, async (tx) => {
    const deleted = await tx.delete(inspectionFinding)
      .where(and(eq(inspectionFinding.id, input.findingId), sql`${inspectionFinding.confirmedAt} is null`))
      .returning({ id: inspectionFinding.id });
    return { dismissed: deleted.length > 0 };
  });
}

export type SetGradeResult =
  | { grade: string }
  | { error: "zone_not_found" | "invalid_grade" | "action_requires_evidence" };

const GRADES = ["good", "monitor", "action"] as const;

/**
 * The inspector's on-site call, with the invariant enforced at the write:
 * grade='action' requires ≥1 CONFIRMED finding on the zone carrying ≥1 photo.
 */
export async function setInspectionZoneGrade(input: {
  tenantId: string;
  inspectionZoneId: string;
  grade: string;
  userId: string | null;
}): Promise<SetGradeResult> {
  if (!GRADES.includes(input.grade as (typeof GRADES)[number])) return { error: "invalid_grade" };
  return withTenant(input.tenantId, async (tx) => {
    const [zone] = await tx.select({ id: inspectionZone.id }).from(inspectionZone)
      .where(eq(inspectionZone.id, input.inspectionZoneId));
    if (!zone) return { error: "zone_not_found" as const };

    if (input.grade === "action") {
      const [evidence] = await tx.select({ id: inspectionFinding.id }).from(inspectionFinding)
        .where(and(
          eq(inspectionFinding.inspectionZoneId, input.inspectionZoneId),
          isNotNull(inspectionFinding.confirmedAt),
          sql`jsonb_array_length(${inspectionFinding.photoIds}) > 0`,
        ))
        .limit(1);
      if (!evidence) return { error: "action_requires_evidence" as const };
    }

    await tx.update(inspectionZone)
      .set({ grade: input.grade, gradeSetByUserId: input.userId })
      .where(eq(inspectionZone.id, input.inspectionZoneId));
    return { grade: input.grade };
  });
}

/** Zones graded ACTION without photo-backed confirmed findings — the sweep query
 *  behind the roof_record.no_unsupported_action evidence check. Must be empty. */
export async function listUnsupportedActionZones(tenantId: string): Promise<{ zoneId: string }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select({ zoneId: inspectionZone.id }).from(inspectionZone)
      .where(and(
        eq(inspectionZone.grade, "action"),
        sql`not exists (
          select 1 from ${inspectionFinding} f
          where f.inspection_zone_id = ${inspectionZone.id}
            and f.confirmed_at is not null
            and jsonb_array_length(f.photo_ids) > 0
        )`,
      ));
    return rows;
  });
}
