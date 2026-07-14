import { z } from "@savvy/core";
import * as ai from "@savvy/ai";
import {
  withTenant, eq, and, isNotNull, adminDb, messageTemplate,
  inspection, inspectionZone, inspectionFinding,
  setInspectionNarrative, setZoneSummaries,
} from "@savvy/db";
import { inngest } from "../client";

/**
 * Rubric v1 — seeded to the Library (message_template key below) so revisions
 * are config, not code. The code constant is the fallback for tenants that
 * haven't customized it.
 */
export const NARRATIVE_RUBRIC_KEY = "roof-record-narrative-rubric";
export const NARRATIVE_RUBRIC_V1 =
  "Write plain English a homeowner trusts. No fear language, no hype adjectives, " +
  "no urgency theatrics. Describe what was seen, why it matters, and the honest " +
  "timeframe. Never recommend full replacement unless told replacement-factor " +
  "findings exist. When the roof is healthy, say so plainly and warmly — a fine " +
  "roof is a fine outcome. 2–3 sentences per zone; 3–5 sentences for the whole roof.";

const narrativeSchema = z.object({
  narrative: z.string().min(1),
  zones: z.array(z.object({ zoneKey: z.string(), summary: z.string() })),
});

export type DraftNarrativeResult =
  | { narrative: string; zonesSummarized: number; rubricViolation: boolean }
  | { skipped: "inspection_not_found" | "inspector_edited" };

/**
 * Drafts (a) per-zone 2–3 sentence summaries and (b) the whole-roof narrative
 * from the inspector's own evidence (grades + CONFIRMED findings + notes) via
 * the cheap capability. HARD RUBRIC GUARD: replacement language without a
 * replacement_factor finding is stripped and replaced with a deterministic
 * grade-based fallback — the model is instructed, but the invariant is code.
 * Never overwrites an inspector-edited narrative.
 */
export async function draftInspectionNarrative(
  input: { tenantId: string; inspectionId: string },
  aiClient: Pick<typeof ai, "completeObject"> = ai,
): Promise<DraftNarrativeResult> {
  const snapshot = await withTenant(input.tenantId, async (tx) => {
    const [insp] = await tx.select({
      id: inspection.id, editedAt: inspection.narrativeEditedAt,
    }).from(inspection).where(eq(inspection.id, input.inspectionId));
    if (!insp) return null;

    const zones = await tx.select({
      id: inspectionZone.id, zoneKey: inspectionZone.zoneKey, zoneLabel: inspectionZone.zoneLabel,
      zoneKind: inspectionZone.zoneKind, grade: inspectionZone.grade, inspectorNotes: inspectionZone.inspectorNotes,
    }).from(inspectionZone).where(eq(inspectionZone.inspectionId, input.inspectionId));

    const findings = zones.length
      ? await tx.select({
          zoneId: inspectionFinding.inspectionZoneId, whatItIs: inspectionFinding.whatItIs,
          ifIgnored: inspectionFinding.ifIgnored, timeframe: inspectionFinding.timeframe,
          disposition: inspectionFinding.disposition,
        }).from(inspectionFinding)
          .innerJoin(inspectionZone, eq(inspectionFinding.inspectionZoneId, inspectionZone.id))
          .where(and(eq(inspectionZone.inspectionId, input.inspectionId), isNotNull(inspectionFinding.confirmedAt)))
      : [];
    return { insp, zones, findings };
  });
  if (!snapshot) return { skipped: "inspection_not_found" as const };
  if (snapshot.insp.editedAt) return { skipped: "inspector_edited" as const };

  // Library-first rubric: a tenant-edited message_template overrides the constant.
  const [tpl] = await adminDb.select({ body: messageTemplate.body }).from(messageTemplate)
    .where(and(eq(messageTemplate.tenantId, input.tenantId), eq(messageTemplate.key, NARRATIVE_RUBRIC_KEY)));
  const rubric = tpl?.body?.trim() || NARRATIVE_RUBRIC_V1;

  const hasReplacementFactor = snapshot.findings.some((f) => f.disposition === "replacement_factor");
  const zoneLines = snapshot.zones.map((zone) => {
    const zf = snapshot.findings.filter((f) => f.zoneId === zone.id);
    const notes = (zone.inspectorNotes as { text: string }[]).map((n) => n.text).join("; ");
    return `- ${zone.zoneLabel} (${zone.zoneKind}, key=${zone.zoneKey}, grade=${zone.grade ?? "ungraded"})` +
      (zf.length ? ` findings: ${zf.map((f) => `${f.whatItIs}${f.timeframe ? ` [${f.timeframe}]` : ""}`).join(" | ")}` : " no findings") +
      (notes ? ` notes: ${notes}` : "");
  }).join("\n");

  const { object } = await aiClient.completeObject({
    capability: "workhorse",
    system: `${rubric}\n\nReplacement-factor findings present: ${hasReplacementFactor ? "YES" : "NO — do not mention replacement at all"}.`,
    prompt: `Zones inspected:\n${zoneLines}\n\nReturn a summary per zone (keyed by zoneKey) and the whole-roof narrative.`,
    schema: narrativeSchema,
  });

  // The invariant is code, not prompt: without replacement_factor findings any
  // replacement talk is discarded for a deterministic grade-based fallback.
  const mentionsReplacement = /replac/i.test(object.narrative);
  const rubricViolation = mentionsReplacement && !hasReplacementFactor;
  const graded = snapshot.zones.filter((z) => z.grade);
  const fallback = graded.length
    ? `We inspected ${snapshot.zones.length} zones. ${graded.filter((z) => z.grade === "good").length} look good, ` +
      `${graded.filter((z) => z.grade === "monitor").length} are worth monitoring, and ` +
      `${graded.filter((z) => z.grade === "action").length} need attention — details in each zone below.`
    : `We inspected ${snapshot.zones.length} zones — details in each zone below.`;
  const narrative = rubricViolation ? fallback : object.narrative;

  const zoneSummaries = object.zones
    .filter((zs) => !(/replac/i.test(zs.summary) && !hasReplacementFactor))
    .map((zs) => ({ zoneKey: zs.zoneKey, summary: zs.summary }));

  const saved = await setInspectionNarrative({ tenantId: input.tenantId, inspectionId: input.inspectionId, narrative, source: "ai" });
  if ("skipped" in saved) return { skipped: "inspector_edited" as const };
  const { updated } = await setZoneSummaries({ tenantId: input.tenantId, inspectionId: input.inspectionId, summaries: zoneSummaries });

  return { narrative, zonesSummarized: updated, rubricViolation };
}

/** On completion: draft the narrative right after the final estimate re-price. */
export const inspectionNarrativeOnComplete = inngest.createFunction(
  { id: "inspection-narrative-on-complete", retries: 2 },
  { event: "inspection/completed" },
  async ({ event, step }) => {
    const { tenantId, inspectionId } = event.data;
    return step.run("draft-narrative", () => draftInspectionNarrative({ tenantId, inspectionId }));
  },
);
