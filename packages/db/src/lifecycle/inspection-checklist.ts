import { withTenant } from "../tenant";
import { inspectionChecklist } from "../schema/inspection";

type ChecklistItem = {
  key: string;
  prompt: string;
  input: "pass_fail" | "count" | "measure" | "photo_required" | "note";
  // Template stamped onto auto-suggested findings (slice 2 wires the suggestion
  // flow; the shape ships now so BloomCam checklists can bind item keys).
  maps_to_finding: { what_it_is: string; if_ignored: string; timeframe: string; severity: "monitor" | "action" } | null;
  friend_rule_eligible: boolean;
};

type ChecklistSeed = { key: string; zoneKind: string; name: string; items: ChecklistItem[] };

/**
 * v1 checklists, adapted from BloomCam's built-in templates (Storm Damage
 * Inspection + Roof Replacement) into per-zone-kind Library documents. The
 * owner has flagged these for improvement — revisions are NEW VERSION ROWS
 * edited in the Library, never code changes. Zones stamp checklist_version_ref
 * at capture, so every Record is auditable against the checklist that drove it.
 */
const CHECKLISTS_V1: ChecklistSeed[] = [
  {
    key: "ground_walk", zoneKind: "ground", name: "Ground walk — elevations & pre-condition",
    items: [
      { key: "elevation_photo", prompt: "Full elevation, corner to corner", input: "photo_required", maps_to_finding: null, friend_rule_eligible: false },
      { key: "siding_windows", prompt: "Siding, windows, screens — any impact marks?", input: "pass_fail", maps_to_finding: { what_it_is: "Impact marks on siding or window screens", if_ignored: "Evidence fades and the claim window narrows", timeframe: "Document now", severity: "monitor" }, friend_rule_eligible: false },
      { key: "landscape_precondition", prompt: "Landscape / driveway pre-work condition", input: "photo_required", maps_to_finding: null, friend_rule_eligible: false },
      { key: "downspout_splash", prompt: "Downspouts & splash blocks draining clear?", input: "pass_fail", maps_to_finding: { what_it_is: "Downspout not draining away from the foundation", if_ignored: "Pooled water works toward the foundation over time", timeframe: "Within a season", severity: "monitor" }, friend_rule_eligible: true },
    ],
  },
  {
    key: "roof_facet", zoneKind: "facet", name: "Roof slope — field shingles",
    items: [
      { key: "slope_overview", prompt: "Slope overview from the ridge, full frame", input: "photo_required", maps_to_finding: null, friend_rule_eligible: false },
      { key: "sealant_bond", prompt: "Lift 3 shingles at random — sealant bond intact?", input: "pass_fail", maps_to_finding: { what_it_is: "Shingle sealant strips no longer bonded", if_ignored: "Wind can lift and crease unsealed shingles", timeframe: "Before the next storm season", severity: "action" }, friend_rule_eligible: false },
      { key: "hail_strikes", prompt: "Hail strikes in a 10x10 test square — count", input: "count", maps_to_finding: { what_it_is: "Hail bruising in the field shingles", if_ignored: "Bruises shed granules and open the mat to UV", timeframe: "Claim-relevant — document now", severity: "action" }, friend_rule_eligible: false },
      { key: "granule_loss", prompt: "Granule loss / exposed mat anywhere on the slope?", input: "pass_fail", maps_to_finding: { what_it_is: "Granule loss exposing the asphalt mat", if_ignored: "UV ages exposed mat quickly", timeframe: "Within 1–2 years", severity: "monitor" }, friend_rule_eligible: false },
      { key: "nail_pops", prompt: "Nail pops — count and reseat", input: "count", maps_to_finding: { what_it_is: "Nail pops lifting shingle tabs", if_ignored: "Each pop is a future leak path", timeframe: "This visit", severity: "monitor" }, friend_rule_eligible: true },
    ],
  },
  {
    key: "roof_edges", zoneKind: "ridge", name: "Ridge, hips & valleys",
    items: [
      { key: "ridge_cap", prompt: "Ridge cap condition — cracks, blow-offs?", input: "pass_fail", maps_to_finding: { what_it_is: "Cracked or missing ridge cap shingles", if_ignored: "The ridge takes wind first; open caps leak at the peak", timeframe: "Before the next storm season", severity: "action" }, friend_rule_eligible: false },
      { key: "valley_debris", prompt: "Valleys clear of debris and granule dams?", input: "pass_fail", maps_to_finding: { what_it_is: "Debris damming the valley", if_ignored: "Dammed water backs under the shingles", timeframe: "This season", severity: "monitor" }, friend_rule_eligible: true },
      { key: "valley_metal", prompt: "Valley metal / weave condition photo", input: "photo_required", maps_to_finding: null, friend_rule_eligible: false },
    ],
  },
  {
    key: "penetrations", zoneKind: "penetrations", name: "Penetrations & flashing",
    items: [
      { key: "pipe_boots", prompt: "Pipe boots — cracked or UV-split rubber?", input: "pass_fail", maps_to_finding: { what_it_is: "Cracked pipe-boot gasket", if_ignored: "The most common single-point leak on a roof", timeframe: "This visit", severity: "action" }, friend_rule_eligible: true },
      { key: "flashing_seal", prompt: "Step/counter flashing sealed at walls & chimney?", input: "pass_fail", maps_to_finding: { what_it_is: "Open flashing joint at a wall or chimney", if_ignored: "Wind-driven rain enters at the joint", timeframe: "Within a season", severity: "action" }, friend_rule_eligible: false },
      { key: "vents_soft_metal", prompt: "Vents & soft metals — hail dings photo", input: "photo_required", maps_to_finding: { what_it_is: "Hail dents in soft-metal vents", if_ignored: "Soft-metal strikes corroborate the field damage", timeframe: "Claim-relevant — document now", severity: "monitor" }, friend_rule_eligible: false },
    ],
  },
  {
    key: "gutters", zoneKind: "gutters", name: "Gutters & downspouts",
    items: [
      { key: "gutter_granules", prompt: "Granule accumulation in gutters — heavy?", input: "pass_fail", maps_to_finding: { what_it_is: "Heavy granule wash-off collecting in gutters", if_ignored: "Confirms the field shingles are shedding", timeframe: "Monitor yearly", severity: "monitor" }, friend_rule_eligible: false },
      { key: "gutter_dents", prompt: "Hail dents on gutter tops / downspouts photo", input: "photo_required", maps_to_finding: null, friend_rule_eligible: false },
      { key: "gutter_pitch", prompt: "Gutters pitched and draining? Resecure loose hangers", input: "pass_fail", maps_to_finding: { what_it_is: "Loose gutter hangers", if_ignored: "Sagging sections overflow at the fascia", timeframe: "This visit", severity: "monitor" }, friend_rule_eligible: true },
    ],
  },
  {
    key: "attic", zoneKind: "attic", name: "Attic & interior",
    items: [
      { key: "attic_daylight", prompt: "Daylight through the deck anywhere?", input: "pass_fail", maps_to_finding: { what_it_is: "Daylight visible through the roof deck", if_ignored: "An open deck path leaks in the first hard rain", timeframe: "Immediately", severity: "action" }, friend_rule_eligible: false },
      { key: "attic_stains", prompt: "Water stains / active leak marks photo", input: "photo_required", maps_to_finding: { what_it_is: "Water staining on the decking or insulation", if_ignored: "Stains mark an active or recent leak path", timeframe: "Trace this visit", severity: "action" }, friend_rule_eligible: false },
      { key: "ventilation_nfa", prompt: "Intake/exhaust ventilation present and clear?", input: "pass_fail", maps_to_finding: { what_it_is: "Blocked or missing attic ventilation", if_ignored: "Heat load shortens shingle life from below", timeframe: "Within a year", severity: "monitor" }, friend_rule_eligible: false },
    ],
  },
];

/** Seeds the v1 checklist library for a tenant. Idempotent: any existing
 *  checklist rows (including later versions) mean the library is live — never touch. */
export async function ensureInspectionChecklists(tenantId: string): Promise<{ seeded: number }> {
  return withTenant(tenantId, async (tx) => {
    const existing = await tx.select({ id: inspectionChecklist.id }).from(inspectionChecklist).limit(1);
    if (existing.length > 0) return { seeded: 0 };
    const inserted = await tx
      .insert(inspectionChecklist)
      .values(CHECKLISTS_V1.map((c) => ({ tenantId, key: c.key, version: 1, zoneKind: c.zoneKind, name: c.name, items: c.items })))
      .onConflictDoNothing()
      .returning({ id: inspectionChecklist.id });
    return { seeded: inserted.length };
  });
}
