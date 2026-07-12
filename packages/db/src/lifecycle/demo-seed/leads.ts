import { and, eq } from "drizzle-orm";
import { adminDb } from "../../admin-client";
import { withTenant } from "../../tenant";
import { lead, customer } from "../../schema/crm";
import { drip, dripEnrollment } from "../../schema/comms";
import { createLeadForTenant } from "../lead-intake";
import { markLeadContacted } from "../contact";
import { setLeadOwner, setLeadLost } from "../leads";
import { addLeadNote } from "../lead-note";
import { bookLeadSlot } from "../booking";
import { appointment } from "../../schema/comms";
import { demoStaff, inspectionSlotForTesting } from "./funnel";

/**
 * Ids of the 5 demo leads keyed by their terminal state, one per state of the
 * lead funnel: new / contacted (active drip) / qualified (scored) /
 * booked (inspection scheduled) / lost (with reason note).
 */
export interface DemoLeadIds {
  new: string;
  contacted: string;
  qualified: string;
  booked: string;
  lost: string;
}

const DEMO_DRIP_KEY = "demo-nurture";

/** Deterministic natural key per state so re-running the seeder dedupes via
 * createLeadForTenant's phone/email match instead of creating duplicate leads. */
const DEMO_LEAD_SEEDS = [
  {
    state: "new" as const,
    name: "Nina Newlead",
    phone: "+16025550401",
    email: "nina.newlead@demo.test",
    address: "301 W Camelback Rd, Phoenix, AZ 85013",
  },
  {
    state: "contacted" as const,
    name: "Carl Contacted",
    phone: "+16025550402",
    email: "carl.contacted@demo.test",
    address: "302 W Camelback Rd, Phoenix, AZ 85013",
  },
  {
    state: "qualified" as const,
    name: "Quinn Qualified",
    phone: "+16025550403",
    email: "quinn.qualified@demo.test",
    address: "303 W Camelback Rd, Phoenix, AZ 85013",
  },
  {
    state: "booked" as const,
    name: "Bianca Booked",
    phone: "+16025550404",
    email: "bianca.booked@demo.test",
    address: "304 W Camelback Rd, Phoenix, AZ 85013",
  },
  {
    state: "lost" as const,
    name: "Leo Lost",
    phone: "+16025550405",
    email: "leo.lost@demo.test",
    address: "305 W Camelback Rd, Phoenix, AZ 85013",
  },
];

/** Find an existing lead for this tenant by the seed's phone (matches the
 * customer.phone dedupe key `createLeadForTenant` uses), so re-running the
 * seeder reuses the same lead instead of creating a second one. */
async function findExistingSeedLead(tenantId: string, phone: string): Promise<string | undefined> {
  const [row] = await adminDb
    .select({ id: lead.id })
    .from(lead)
    .innerJoin(customer, eq(customer.id, lead.customerId))
    .where(and(eq(lead.tenantId, tenantId), eq(customer.phone, phone)));
  return row?.id;
}

/** Idempotently ensure the tenant has the demo nurture drip template, returning its id. */
async function ensureDemoDrip(tenantId: string): Promise<string> {
  const [existing] = await adminDb
    .select({ id: drip.id })
    .from(drip)
    .where(and(eq(drip.tenantId, tenantId), eq(drip.key, DEMO_DRIP_KEY)));
  if (existing) return existing.id;
  const [row] = await adminDb
    .insert(drip)
    .values({
      tenantId,
      key: DEMO_DRIP_KEY,
      name: "Demo Nurture Drip",
      triggerEvent: "lead/contacted",
      steps: [],
    })
    .returning({ id: drip.id });
  return row!.id;
}

/** Idempotently ensure the lead has an active enrollment on the demo drip. */
async function ensureActiveDripEnrollment(input: {
  tenantId: string;
  leadId: string;
  customerId: string;
  dripId: string;
}): Promise<void> {
  const [existing] = await adminDb
    .select({ id: dripEnrollment.id })
    .from(dripEnrollment)
    .where(
      and(
        eq(dripEnrollment.tenantId, input.tenantId),
        eq(dripEnrollment.dripId, input.dripId),
        eq(dripEnrollment.customerId, input.customerId),
        eq(dripEnrollment.status, "active"),
      ),
    );
  if (existing) return;
  await adminDb.insert(dripEnrollment).values({
    tenantId: input.tenantId,
    dripId: input.dripId,
    customerId: input.customerId,
    leadId: input.leadId,
    status: "active",
  });
}

/**
 * Seed the 5 demo leads — one per funnel state — via real lifecycle
 * functions so the demo shows honest, machine-produced state rather than
 * hand-faked rows. Deterministic natural keys (fixed phone/email/address per
 * state) make this idempotent: re-running reuses the same 5 leads.
 */
export async function seedDemoLeads(tenantId: string): Promise<DemoLeadIds> {
  const repA = await demoStaff(tenantId, "usr_demo_repA");
  const repB = await demoStaff(tenantId, "usr_demo_repB");

  const ids = {} as DemoLeadIds;

  for (const seed of DEMO_LEAD_SEEDS) {
    let leadId = await findExistingSeedLead(tenantId, seed.phone);
    if (!leadId) {
      leadId = await createLeadForTenant(tenantId, {
        name: seed.name,
        phone: seed.phone,
        email: seed.email,
        address: seed.address,
        source: "web",
      });
    }
    ids[seed.state] = leadId;
  }

  // Distribute ownership across the two demo reps.
  await withTenant(tenantId, async (tx) => {
    await setLeadOwner(tx, { tenantId, leadId: ids.new, userId: repA });
    await setLeadOwner(tx, { tenantId, leadId: ids.contacted, userId: repA });
    await setLeadOwner(tx, { tenantId, leadId: ids.qualified, userId: repB });
    await setLeadOwner(tx, { tenantId, leadId: ids.booked, userId: repB });
    await setLeadOwner(tx, { tenantId, leadId: ids.lost, userId: repA });
  });

  // `new`: left as-is — no enrichment.

  // `contacted`: mark first-contact + status, then ensure an active drip enrollment.
  const [contactedLead] = await adminDb.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, ids.contacted));
  await withTenant(tenantId, async (tx) => {
    await markLeadContacted(tx, { tenantId, leadId: ids.contacted });
  });
  await adminDb.update(lead).set({ status: "contacted" }).where(and(eq(lead.id, ids.contacted), eq(lead.tenantId, tenantId)));
  const dripId = await ensureDemoDrip(tenantId);
  await ensureActiveDripEnrollment({
    tenantId,
    leadId: ids.contacted,
    customerId: contactedLead!.customerId!,
    dripId,
  });

  // `qualified`: no lifecycle gate for this — set status + score directly.
  await adminDb
    .update(lead)
    .set({ status: "qualified", score: 82, scoreBand: "hot" })
    .where(and(eq(lead.id, ids.qualified), eq(lead.tenantId, tenantId)));

  // `booked`: real inspection appointment via the collision-proof funnel helper, then status.
  await ensureLeadInspectionBooking(tenantId, ids.booked);
  await adminDb.update(lead).set({ status: "booked" }).where(and(eq(lead.id, ids.booked), eq(lead.tenantId, tenantId)));

  // `lost`: real setLeadLost + a note carrying the reason (no dedicated reason column).
  await withTenant(tenantId, async (tx) => {
    await setLeadLost(tx, { tenantId, leadId: ids.lost });
    await addLeadNote(tx, {
      tenantId,
      leadId: ids.lost,
      authorUserId: null,
      body: "Lost — went with another contractor (price).",
    });
  });

  return ids;
}

// A slot offset far past the funnel's default "next Thursday 10:00" start (used by
// Task 10/11's seeded leads at offset 0) so this demo lead's inspection doesn't collide
// with theirs on the shared dev Postgres.
const BOOKED_LEAD_SLOT_OFFSET = 4000;
const MAX_SLOT_COLLISION_RETRIES = 40;

/** `booked` needs a *scheduled* inspection (not `done`) so the lead genuinely reads as
 * "booked" rather than already inspected — book directly via `bookLeadSlot` (idempotent:
 * reuses an existing scheduled/done appointment on re-run, retrying past `slot_taken`
 * collisions otherwise) instead of the funnel's `ensureLeadInspectionAppointment`, which
 * always advances the appointment to `done`. */
async function ensureLeadInspectionBooking(tenantId: string, leadId: string): Promise<void> {
  const [existing] = await adminDb
    .select({ id: appointment.id })
    .from(appointment)
    .where(and(eq(appointment.tenantId, tenantId), eq(appointment.leadId, leadId), eq(appointment.type, "inspection")));
  if (existing) return;

  for (let attempt = 0; attempt < MAX_SLOT_COLLISION_RETRIES; attempt++) {
    const slot = inspectionSlotForTesting(BOOKED_LEAD_SLOT_OFFSET + attempt);
    const booked = await bookLeadSlot({ leadId, ...slot });
    if (!("error" in booked)) return;
    if (booked.error !== "slot_taken") throw new Error(`bookLeadSlot failed: ${booked.error}`);
  }
  throw new Error(`bookLeadSlot: exhausted ${MAX_SLOT_COLLISION_RETRIES} slot_taken retries for lead ${leadId}`);
}
