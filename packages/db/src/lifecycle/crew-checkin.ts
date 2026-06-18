import { and, eq, isNull, desc } from "drizzle-orm";
import { crewCheckin } from "../schema/index";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

type Loc = { lat?: number | null; lng?: number | null };
type Key = { tenantId: string; jobId: string; crewUserId: string };

async function findOpen(tx: Tx, k: Key) {
  const [row] = await tx
    .select({ id: crewCheckin.id })
    .from(crewCheckin)
    .where(and(
      eq(crewCheckin.tenantId, k.tenantId),
      eq(crewCheckin.jobId, k.jobId),
      eq(crewCheckin.crewUserId, k.crewUserId),
      isNull(crewCheckin.checkedOutAt),
    ))
    .orderBy(desc(crewCheckin.checkedInAt))
    .limit(1);
  return row;
}

/** Opens a check-in; returns the existing open row if one exists (idempotent). */
export async function openCheckIn(tx: Tx, opts: Key & Loc): Promise<{ id: string; reused: boolean }> {
  const open = await findOpen(tx, opts);
  if (open) return { id: open.id, reused: true };
  const [row] = await tx.insert(crewCheckin).values({
    tenantId: opts.tenantId, jobId: opts.jobId, crewUserId: opts.crewUserId,
    checkInLat: opts.lat ?? null, checkInLng: opts.lng ?? null,
  }).returning({ id: crewCheckin.id });
  return { id: row!.id, reused: false };
}

/** Closes the latest open check-in; no-op (null) if none open. */
export async function closeCheckIn(tx: Tx, opts: Key & Loc): Promise<{ id: string } | null> {
  const open = await findOpen(tx, opts);
  if (!open) return null;
  await tx.update(crewCheckin).set({
    checkedOutAt: new Date(), checkOutLat: opts.lat ?? null, checkOutLng: opts.lng ?? null,
  }).where(eq(crewCheckin.id, open.id));
  return { id: open.id };
}
