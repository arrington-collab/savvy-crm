import "server-only";
import { withTenant, lead, customer, property, user, communication, count, eq, not, inArray, desc, sql, getLeadArtifacts, getLeadNotes, type LeadArtifacts } from "@savvy/db";
import { LEAD_STATUS, type LeadStatus } from "@savvy/core";
import { getTenantId } from "./tenant";

/** Tenant-scoped wrapper for the lead's Measurement + Estimate tile sections. */
export async function getLeadArtifactsForLead(leadId: string): Promise<LeadArtifacts> {
  const tenantId = await getTenantId();
  return getLeadArtifacts({ tenantId, leadId });
}

export type LeadListRow = {
  id: string;
  status: string;
  score: number | null;
  source: string | null;
  customerName: string | null;
  address: string | null;
  createdAt: Date;
};

export async function getLeads(
  opts: { status?: LeadStatus; sort?: "score" | "age" } = {},
): Promise<LeadListRow[]> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: lead.id,
        status: lead.status,
        score: lead.score,
        source: lead.source,
        customerName: customer.name,
        address: property.address,
        createdAt: lead.createdAt,
      })
      .from(lead)
      .leftJoin(customer, eq(customer.id, lead.customerId))
      .leftJoin(property, eq(property.id, lead.propertyId))
      // A specific chip filters to that status (won/lost stay reachable that way); the
      // default (unfiltered) view is the ACTIVE pipeline — won/lost don't render there.
      .where(opts.status ? eq(lead.status, opts.status) : not(inArray(lead.status, ["won", "lost"])))
      .orderBy(
        ...(opts.sort === "age"
          ? [desc(lead.createdAt)]
          : [sql`${lead.score} desc nulls last`, desc(lead.createdAt)]),
      ),
  );
}

export async function getLeadFunnelCounts(): Promise<Record<LeadStatus, number>> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ status: lead.status, n: count() }).from(lead).groupBy(lead.status),
  );
  const out = Object.fromEntries(LEAD_STATUS.map((s) => [s, 0])) as Record<LeadStatus, number>;
  for (const r of rows) out[r.status as LeadStatus] = r.n;
  return out;
}

export type LeadComm = {
  id: string;
  channel: string;
  direction: string;
  body: string | null;
  createdAt: Date;
};

export type LeadNoteRow = {
  id: string;
  body: string;
  authorUserId: string | null;
  authorName: string | null;
  createdAt: Date;
};

export type ScoreFactor = { label: string; points: number };

export type LeadDetail = {
  id: string;
  status: string;
  score: number | null;
  scoreBand: string | null;
  scoreReason: string | null;
  scoreFeatures: { factors?: ScoreFactor[]; baseline?: number; reasons?: string[] } | null;
  installRecommendation: {
    windRating: string;
    impactResistance: string;
    suggestedProducts: string[];
    rationale: string;
  } | null;
  source: string | null;
  propertyId: string | null;
  customerName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  state: string | null;
  county: string | null;
  yearBuilt: number | null;
  roofType: string | null;
  roofTypeSecondary: string | null;
  lastRoofReplacementAt: string | null;
  lastRoofReplacementSource: string | null;
  assignedUserId: string | null;
  ownerName: string | null;
  communications: LeadComm[];
  notes: LeadNoteRow[];
  stormCertStatus: "pending" | "verified" | "none" | "error";
  stormCheckedAt: Date | null;
  stormCertDocumentId: string | null;
  firstRepContactAt: Date | null;
};

export async function getLeadDetail(id: string): Promise<LeadDetail | null> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: lead.id,
        status: lead.status,
        score: lead.score,
        scoreBand: lead.scoreBand,
        scoreReason: lead.scoreReason,
        scoreFeatures: lead.scoreFeatures,
        installRecommendation: lead.installRecommendation,
        source: lead.source,
        customerId: lead.customerId,
        propertyId: lead.propertyId,
        customerName: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: property.address,
        lat: property.lat,
        lng: property.lng,
        state: property.state,
        county: property.county,
        yearBuilt: property.yearBuilt,
        roofType: property.roofType,
        roofTypeSecondary: property.roofTypeSecondary,
        lastRoofReplacementAt: property.lastRoofReplacementAt,
        lastRoofReplacementSource: property.lastRoofReplacementSource,
        assignedUserId: lead.assignedUserId,
        ownerName: user.name,
        stormCertStatus: lead.stormCertStatus,
        stormCheckedAt: lead.stormCheckedAt,
        stormCertDocumentId: lead.stormCertDocumentId,
        firstRepContactAt: lead.firstRepContactAt,
      })
      .from(lead)
      .leftJoin(customer, eq(customer.id, lead.customerId))
      .leftJoin(property, eq(property.id, lead.propertyId))
      .leftJoin(user, eq(user.id, lead.assignedUserId))
      .where(eq(lead.id, id))
      .limit(1);
    if (!row) return null;
    const communications: LeadComm[] = row.customerId
      ? await tx
          .select({
            id: communication.id,
            channel: communication.channel,
            direction: communication.direction,
            body: communication.body,
            createdAt: communication.createdAt,
          })
          .from(communication)
          .where(eq(communication.customerId, row.customerId))
          .orderBy(desc(communication.createdAt))
          .limit(20)
      : [];
    const noteRows = await getLeadNotes(tx, { tenantId, leadId: id });
    const authorIds = [...new Set(noteRows.map((n) => n.authorUserId).filter((v): v is string => v !== null))];
    const authorNames = authorIds.length
      ? await tx
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, authorIds))
      : [];
    const authorNameById = new Map(authorNames.map((a) => [a.id, a.name]));
    const notes: LeadNoteRow[] = noteRows.map((n) => ({
      id: n.id,
      body: n.body,
      authorUserId: n.authorUserId,
      authorName: n.authorUserId ? (authorNameById.get(n.authorUserId) ?? null) : null,
      createdAt: n.createdAt,
    }));
    return {
      id: row.id,
      status: row.status,
      score: row.score,
      scoreBand: row.scoreBand,
      scoreReason: row.scoreReason,
      scoreFeatures: row.scoreFeatures as LeadDetail["scoreFeatures"],
      installRecommendation: row.installRecommendation as LeadDetail["installRecommendation"],
      source: row.source,
      propertyId: row.propertyId,
      customerName: row.customerName,
      phone: row.phone,
      email: row.email,
      address: row.address,
      lat: row.lat,
      lng: row.lng,
      state: row.state,
      county: row.county,
      yearBuilt: row.yearBuilt,
      roofType: row.roofType,
      roofTypeSecondary: row.roofTypeSecondary,
      lastRoofReplacementAt: row.lastRoofReplacementAt,
      lastRoofReplacementSource: row.lastRoofReplacementSource,
      assignedUserId: row.assignedUserId,
      ownerName: row.ownerName,
      communications,
      notes,
      stormCertStatus: row.stormCertStatus,
      stormCheckedAt: row.stormCheckedAt,
      stormCertDocumentId: row.stormCertDocumentId,
      firstRepContactAt: row.firstRepContactAt,
    };
  });
}
