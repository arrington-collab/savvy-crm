import { and, eq } from "drizzle-orm";
import type { Tx } from "../tenant";
import { canvassKnock, canvassRep, canvassTerritory } from "../schema/index";

export interface CanvassKnockUpsert {
  tenantId: string;
  repId: string;
  clientId: string;
  lat: number;
  lng: number;
  outcome: string;
  address?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
  amount?: number | null;
  scheduledAt?: Date | null;
  /** Field app's local territory id; resolved to canvass_territory.id (or null). */
  territoryClientId?: string | null;
  gpsFlagged: boolean;
  gpsDistanceM?: number | null;
}

// Upsert a knock on (tenant, clientId). A replay is a no-op-shaped update; an
// edit (outcome change from the contact sheet, appt→sale after a contract
// signs) overwrites the mutable fields instead of being silently dropped.
// The conflict update is scoped to the OWNING rep (setWhere): GET /knocks
// exposes teammates' clientIds, so an unscoped upsert would let any rep
// overwrite (steal) another rep's knock. A blocked edit returns id null.
export async function upsertCanvassKnock(tx: Tx, k: CanvassKnockUpsert): Promise<{ id: string | null }> {
  let territoryId: string | null = null;
  if (k.territoryClientId) {
    const [terr] = await tx
      .select({ id: canvassTerritory.id })
      .from(canvassTerritory)
      .where(and(eq(canvassTerritory.tenantId, k.tenantId), eq(canvassTerritory.clientId, k.territoryClientId)));
    territoryId = terr?.id ?? null;
  }
  const mutable = {
    lat: k.lat,
    lng: k.lng,
    outcome: k.outcome,
    address: k.address ?? null,
    contactName: k.contactName ?? null,
    contactPhone: k.contactPhone ?? null,
    notes: k.notes ?? null,
    amount: k.amount ?? null,
    scheduledAt: k.scheduledAt ?? null,
    territoryId,
    gpsFlagged: k.gpsFlagged,
    gpsDistanceM: k.gpsDistanceM ?? null,
  };
  const rows = await tx
    .insert(canvassKnock)
    .values({ tenantId: k.tenantId, repId: k.repId, clientId: k.clientId, ...mutable })
    .onConflictDoUpdate({
      target: [canvassKnock.tenantId, canvassKnock.clientId],
      set: mutable,
      setWhere: eq(canvassKnock.repId, k.repId),
    })
    .returning({ id: canvassKnock.id });
  return { id: rows[0]?.id ?? null };
}

// True when the session's rep exists, is active, and carries the manager flag —
// the authority check behind field-app rep/territory management.
export async function isCanvassManager(tx: Tx, tenantId: string, repId: string): Promise<boolean> {
  const [rep] = await tx
    .select({ manager: canvassRep.manager, active: canvassRep.active })
    .from(canvassRep)
    .where(and(eq(canvassRep.tenantId, tenantId), eq(canvassRep.id, repId)));
  return !!rep && rep.manager && rep.active !== false;
}
