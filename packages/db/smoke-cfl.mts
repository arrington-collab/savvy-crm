/**
 * Customer for Life — full-journey smoke test (spec §Verify live).
 * Runs against the LOCAL dev database with simulated time (every lifecycle
 * function takes a `now` override). One customer, start to finish:
 *
 *   job completes → auto-enroll → 30-day check-in text → retail day-30 absorbed
 *   → holiday postcard held print_pending → roofiversary year 1 sent + year 2
 *   scheduled → governor blocks the 6th touch + storm displaces → claim-dispute
 *   hold refuses → NCOA move signal raises the verification card → confirm →
 *   Play A text + reply creates the new-address lead → Play B transfer page →
 *   new owner registers, inherits the Roof Record, both parties enrolled →
 *   every evidence check passes.
 *
 * Usage: cd packages/db && npx tsx smoke-cfl.mts
 */
import { eq, and } from "drizzle-orm";
import { adminDb, adminPool } from "./src/admin-client.js";
import {
  customer, property, job, lead, relationshipTouch, relationshipEnrollment,
  warrantyTransfer, tenant as tenantTbl,
} from "./src/schema/index.js";
import {
  enrollmentGaps, cadenceSilenceViolations, jobHasActiveEnrollment,
} from "./src/lifecycle/relationship-enrollment.js";
import { scheduleRelationshipTouch, governorCapViolations } from "./src/lifecycle/relationship-touch.js";
import {
  recordMoveSignal, confirmMove, pendingMoveVerifications, createMoveLeadOnReply,
  movePlayGaps, transfersMissingRecord,
} from "./src/lifecycle/move-play.js";
import { stepAbsorbedByRelationship, signPayloadToken, evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { sweepTenantRelationshipCadence } from "../agents/src/functions/relationship-cadence";
import { getTransferOfferByToken, registerTransferByToken } from "../../apps/web/src/lib/transfer-actions";

const DAY = 86_400_000;
let step = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const section = (msg: string) => console.log(`\n[${++step}] ${msg}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error(`  ✗ FAILED: ${msg}`); process.exit(1); }
  ok(msg);
}

const sent: { to: string; body: string; at: string }[] = [];
let simNow = new Date("2026-07-14T18:00:00Z");
const smsDeps = {
  getTenantSms: (async () => ({
    sender: { sendSms: async (m: { to: string; body: string }) => { sent.push({ ...m, at: simNow.toISOString() }); return { providerId: "smoke" }; } },
    from: "+15555550000",
  })) as never,
  now: () => simNow,
};

// ————— Fixture: tenant + customer + completed job —————
section("Seed: tenant 'SMOKE-CFL', customer Mia, job completed 2026-06-14 at 12 Old Oak Ln");
const [t] = await adminDb.insert(tenantTbl).values({
  name: "SMOKE-CFL", publicKey: `pk-smoke-${crypto.randomUUID()}`, clerkOrgId: `org-smoke-${crypto.randomUUID()}`,
  settings: { homeowner: { quietHours: { startHour: 0, endHour: 0 } } } as never,
}).returning();
const tenantId = t!.id;
const [mia] = await adminDb.insert(customer).values({ tenantId, name: "Mia Martinez", phone: "+16025550101" }).returning();
const baselineInspectionId = crypto.randomUUID();
const [oldHouse] = await adminDb.insert(property).values({
  tenantId, customerId: mia!.id, address: "12 Old Oak Ln, Mesa AZ",
  baselineInspectionId, baselineAt: new Date("2026-06-01T00:00:00Z"),
}).returning();
const completedAt = new Date("2026-06-14T18:00:00Z");
const [roofJob] = await adminDb.insert(job).values({
  tenantId, customerId: mia!.id, propertyId: oldHouse!.id, type: "retail", stage: "complete", stageEnteredAt: completedAt,
}).returning();
ok(`job ${roofJob!.id.slice(0, 8)} complete (baseline inspection on file)`);

// ————— Day 30: sweep enrolls + sends the check-in —————
section("2026-07-14 (day 30): the cadence sweep runs");
const gapsBefore = await enrollmentGaps(tenantId);
assert(gapsBefore.length === 1, "before the sweep, the completed job is an enrollment GAP (evidence sees it)");
const s1 = await sweepTenantRelationshipCadence(tenantId, smsDeps as never);
assert(s1.enrolled === 1, "sweep auto-enrolled the completed job");
assert((await enrollmentGaps(tenantId)).length === 0, "relationship.enrollment evidence: gap cleared");
assert(s1.sent === 1 && sent[0]!.to === "+16025550101", `30-day check-in TEXT sent to Mia`);
console.log(`     → "${sent[0]!.body}"`);
assert(sent[0]!.body.includes("Mia") && /free/i.test(sent[0]!.body), "check-in is personalized + rubric-safe (free offer, no sales)");

const refs = () => adminDb.select().from(relationshipTouch).where(eq(relationshipTouch.customerId, mia!.id));
const allRefs = await refs();
const roofiv1 = allRefs.find((r) => r.sourceRef === `${roofJob!.id}:roofiversary:1`);
const holiday26 = allRefs.find((r) => r.sourceRef === `${roofJob!.id}:holiday:2026`);
assert(roofiv1?.scheduledFor.toISOString().startsWith("2027-06-14"), "roofiversary year 1 on the calendar for 2027-06-14");
assert(holiday26?.channel === "postcard" && holiday26.scheduledFor.toISOString().startsWith("2026-11-26"), "Thanksgiving postcard on the calendar for 2026-11-26");

// ————— Retail drip absorption —————
section("Retail close-out drip reaches its day-30 step");
const enrolled = await jobHasActiveEnrollment(tenantId, roofJob!.id);
assert(enrolled && stepAbsorbedByRelationship({ dayOffset: 30, channel: "sms" }, enrolled), "day-30 drip SMS is ABSORBED by the governed check-in (no double text)");
assert(!stepAbsorbedByRelationship({ dayOffset: 7, channel: "sms" }, enrolled), "day-7 drip step still runs (only day 30 absorbs)");

// ————— Thanksgiving: print piece holds —————
section("2026-11-26: Thanksgiving — postcard due, PostGrid not live");
simNow = new Date("2026-11-26T18:00:00Z");
const s2 = await sweepTenantRelationshipCadence(tenantId, smsDeps as never);
assert(s2.held === 1, "postcard HELD as print_pending (the future PostGrid print queue), not silently dropped");
assert(sent.length === 1, "…and nothing leaked onto the SMS rail");

// ————— Roofiversary year 1 —————
section("2027-06-14: the roof turns one");
simNow = new Date("2027-06-14T18:00:00Z");
const s3 = await sweepTenantRelationshipCadence(tenantId, smsDeps as never);
assert(s3.sent === 1, "roofiversary text sent");
console.log(`     → "${sent[1]!.body}"`);
const refs2 = (await refs()).map((r) => r.sourceRef);
assert(refs2.includes(`${roofJob!.id}:roofiversary:2`), "year-2 roofiversary ALREADY scheduled (the machine remembers postcard #7)");
assert(refs2.includes(`${roofJob!.id}:holiday:2027`), "2027 holiday card already scheduled");

// ————— Governor: cap + displacement (separate customer, isolated ledger) —————
section("Governor: the 6th touch bounces, a storm check displaces");
const [gary] = await adminDb.insert(customer).values({ tenantId, name: "Gary Governor", phone: "+16025550202" }).returning();
for (let i = 0; i < 5; i++) {
  const r = await scheduleRelationshipTouch({ tenantId, customerId: gary!.id, program: "roofiversary", channel: "text", scheduledFor: new Date(simNow.getTime() + (i + 1) * DAY), now: simNow });
  assert("touchId" in r, `touch ${i + 1}/5 admitted`);
}
const sixth = await scheduleRelationshipTouch({ tenantId, customerId: gary!.id, program: "maintenance_offer", channel: "text", scheduledFor: new Date(simNow.getTime() + 10 * DAY), now: simNow });
assert("scheduled" in sixth && sixth.reason === "cap_exceeded", "6th touch REFUSED (cap 5/rolling year) — refusal is a ledger row");
const storm = await scheduleRelationshipTouch({ tenantId, customerId: gary!.id, program: "storm_check", channel: "text", scheduledFor: simNow, now: simNow });
assert("touchId" in storm, "storm_check still admitted at cap (displaces the lowest-priority scheduled touch)");
const displaced = await adminDb.select().from(relationshipTouch)
  .where(and(eq(relationshipTouch.customerId, gary!.id), eq(relationshipTouch.suppressedReason, "displaced")));
assert(displaced.length === 1 && displaced[0]!.program === "roofiversary", "displacement logged (roofiversary bumped, sent history untouched)");

// ————— Claim-dispute hold —————
section("Claim dispute: touches stop instantly");
await adminDb.update(customer).set({ claimDisputeHold: true }).where(eq(customer.id, gary!.id));
const held = await scheduleRelationshipTouch({ tenantId, customerId: gary!.id, program: "holiday_card", channel: "postcard", scheduledFor: simNow, now: simNow });
assert("scheduled" in held && held.reason === "claim_dispute", "touch during an active dispute REFUSED with a claim_dispute ledger row");
await adminDb.update(customer).set({ claimDisputeHold: false }).where(eq(customer.id, gary!.id));

// ————— The move —————
section("2027-07-01: NCOA says Mia moved — one soft signal only ASKS");
simNow = new Date("2027-07-01T18:00:00Z");
const sig1 = await recordMoveSignal({ tenantId, customerId: mia!.id, propertyId: oldHouse!.id, kind: "ncoa", newAddress: "77 New Nest Dr, Gilbert AZ", now: simNow });
assert(sig1.status === "pending_verification" && sig1.confidence === 60, "NCOA alone (60 < 80) → verification card, no plays fired");
const cards = await pendingMoveVerifications(tenantId);
assert(cards.some((c) => c.moveEventId === sig1.moveEventId), "the card is live on /today: 'Did Mia Martinez move from 12 Old Oak Ln?'");

section("Owner clicks 'Yes, they moved' — both plays fire");
await confirmMove({ tenantId, moveEventId: sig1.moveEventId, newAddress: "77 New Nest Dr, Gilbert AZ", now: simNow });
const [miaAfter] = await adminDb.select().from(customer).where(eq(customer.id, mia!.id));
assert(miaAfter!.movedAt !== null && miaAfter!.newAddress === "77 New Nest Dr, Gilbert AZ", "customer stamped moved_at + new_address");
const [wt] = await adminDb.select().from(warrantyTransfer).where(eq(warrantyTransfer.moveEventId, sig1.moveEventId));
assert(wt?.status === "offered" && wt.letterStatus === "print_pending", "Play B: warranty-transfer offer created, letter held for PostGrid");
assert(wt!.baselineInspectionId === baselineInspectionId, "…and it carries the Roof Record link");
const s4 = await sweepTenantRelationshipCadence(tenantId, smsDeps as never);
// (Gary's governor-demo touches also come due here — the sweep correctly sends
// every due text; we assert on Mia's move_play specifically.)
const playA = sent.find((m) => m.to === "+16025550101" && /roof record/i.test(m.body));
assert(s4.sent >= 1 && playA, "Play A: move_play text sent to Mia by the sweep");
console.log(`     → "${playA!.body}"`);
assert(/congrats/i.test(playA!.body), "Play A leads warm ('Congrats on the new place'), Roof Record rides along");

section("Mia replies — the lead at the new address");
const reply = await createMoveLeadOnReply(tenantId, mia!.id, new Date());
assert(reply.leadId, "reply converted: ONE lead created");
const [moveLead] = await adminDb.select().from(lead).where(eq(lead.id, reply.leadId!));
const [newProp] = await adminDb.select().from(property).where(eq(property.id, moveLead!.propertyId!));
assert(moveLead!.source === "existing_customer" && newProp!.address === "77 New Nest Dr, Gilbert AZ", "lead source=existing_customer at the NEW property");
assert((await createMoveLeadOnReply(tenantId, mia!.id, new Date())).leadId === null, "second reply deduped (no lead spam)");

// ————— The transfer page —————
section("Play B lands: the new owner opens /transfer/[token]");
const token = signPayloadToken({ tenantId, transferId: wt!.id }, process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret");
const offer = await getTransferOfferByToken(token);
assert(!("error" in offer), "token verifies; the offer page loads");
if (!("error" in offer)) {
  assert(offer.address === "12 Old Oak Ln, Mesa AZ" && offer.companyName === "SMOKE-CFL", `page shows the property + company (${offer.address})`);
  assert(offer.terms.length > 0, "transfer terms render from tenant config");
}
const badToken = await getTransferOfferByToken(token.slice(0, -4) + "XXXX");
assert("error" in badToken, "tampered token REJECTED (red path)");

const reg = await registerTransferByToken(token, { name: "Nina Newowner", phone: "+16025550303", email: "nina@example.com" });
assert("ok" in reg, "Nina registers the transfer");
const [wtAfter] = await adminDb.select().from(warrantyTransfer).where(eq(warrantyTransfer.id, wt!.id));
const [houseAfter] = await adminDb.select().from(property).where(eq(property.id, oldHouse!.id));
assert(wtAfter!.status === "registered" && wtAfter!.toCustomerId !== null, "transfer stamped registered");
assert(houseAfter!.customerId === wtAfter!.toCustomerId, "property reassigned — Nina inherits the Roof Record");
const enrollments = await adminDb.select().from(relationshipEnrollment).where(eq(relationshipEnrollment.jobId, roofJob!.id));
assert(enrollments.length === 2, "BOTH parties ride the standing cadence (Mia at her new place, Nina under the old roof)");
const dupReg = await registerTransferByToken(token, { name: "Impostor" });
assert("error" in dupReg && dupReg.error === "already_registered", "double registration REFUSED (red path)");

// ————— Evidence finale —————
section("Evidence finale: every ledger closes clean");
assert((await enrollmentGaps(tenantId)).length === 0, "relationship.enrollment: no completed job unenrolled");
assert((await cadenceSilenceViolations(tenantId, simNow)).length === 0, "relationship.cadence: no enrolled customer >18mo silent");
assert((await movePlayGaps(tenantId)).length === 0, "relationship.move_play: every confirmed move produced both plays");
assert((await transfersMissingRecord(tenantId)).length === 0, "relationship.warranty_record: every transfer links the Roof Record");
assert((await governorCapViolations(tenantId)).length === 0, "relationship.governor: zero customers over the cap");

const BATCH3 = [
  "roof_record.no_unsupported_action", "roof_record.baseline_coverage", "inspection.linked_reinspection",
  "repair.credit_checkin", "production.phase_evidence", "production.ho_updates", "production.delivery_notice",
  "production.eod", "production.inspection_gate", "relationship.governor", "relationship.enrollment",
  "relationship.cadence", "relationship.move_play", "relationship.warranty_record",
];
const ctx: EvidenceCtx = { tenantId, db: adminPool, params: {}, window: { start: new Date(Date.now() - 7 * DAY), end: new Date() } };
for (const key of BATCH3) {
  const res = await evidenceChecks[key]!(ctx);
  assert(res.status === "pass", `sweep check ${key}: ${res.details}`);
}

console.log(`\n✅ SMOKE PASSED — ${step} stages, ${sent.length} texts sent, 0 violations. Tenant 'SMOKE-CFL' (${tenantId}) left in dev DB for inspection.`);
await adminPool.end();
process.exit(0);
