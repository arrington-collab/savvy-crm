import { and, desc, eq, isNull } from "drizzle-orm";
import type { Tx } from "../tenant";
import { canvassAlert, canvassRep, canvassKnock } from "../schema/index";

export interface AlertRow {
  id: string;
  kind: string;
  knockId: string | null;
  leadId: string | null;
  title: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
}

function toRow(r: typeof canvassAlert.$inferSelect): AlertRow {
  return { id: r.id, kind: r.kind, knockId: r.knockId, leadId: r.leadId, title: r.title, body: r.body, createdAt: r.createdAt, readAt: r.readAt };
}

// Active managers for the tenant (recipients of supervisory alerts).
export async function activeManagerIds(tx: Tx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: canvassRep.id })
    .from(canvassRep)
    .where(and(eq(canvassRep.tenantId, tenantId), eq(canvassRep.manager, true), eq(canvassRep.active, true)));
  return rows.map((r) => r.id);
}

// Minimal knock read for the 30-min watcher.
export async function readKnockForAlert(
  tx: Tx,
  knockId: string,
): Promise<{ outcome: string; contractSignedAt: Date | null; contactName: string | null; address: string | null; repId: string } | null> {
  const [k] = await tx
    .select({ outcome: canvassKnock.outcome, contractSignedAt: canvassKnock.contractSignedAt, contactName: canvassKnock.contactName, address: canvassKnock.address, repId: canvassKnock.repId })
    .from(canvassKnock)
    .where(eq(canvassKnock.id, knockId));
  return k ?? null;
}

// Write one sale_no_contract alert per recipient (seller + active managers, deduped).
// Idempotent: if any alert already exists for this knock, write nothing.
export async function createSaleNoContractAlerts(
  tx: Tx,
  tenantId: string,
  a: { knockId: string; sellerRepId: string; contactLabel: string },
): Promise<{ created: number }> {
  const existing = await tx.select({ id: canvassAlert.id }).from(canvassAlert).where(eq(canvassAlert.knockId, a.knockId));
  if (existing.length > 0) return { created: 0 };
  const managers = await activeManagerIds(tx, tenantId);
  const recipients = [...new Set([a.sellerRepId, ...managers])];
  if (recipients.length === 0) return { created: 0 };
  const title = "Sale needs a contract";
  const body = `${a.contactLabel} — 30 min in, still no signed contract.`;
  await tx.insert(canvassAlert).values(
    recipients.map((repId) => ({ tenantId, kind: "sale_no_contract" as const, repId, knockId: a.knockId, leadId: null, title, body })),
  );
  return { created: recipients.length };
}

// Security tripwire: too many wrong PINs for one rep name → alert every active
// manager so a guessing attempt surfaces as a 🔔 instead of silence.
export async function createPinLockoutAlert(tx: Tx, tenantId: string, repName: string): Promise<{ created: number }> {
  const managers = await activeManagerIds(tx, tenantId);
  if (managers.length === 0) return { created: 0 };
  const title = "Security: repeated PIN failures";
  const body = `Someone entered the wrong PIN for "${repName}" too many times. That login is locked for 15 minutes.`;
  await tx.insert(canvassAlert).values(
    managers.map((repId) => ({ tenantId, kind: "pin_lockout" as const, repId, knockId: null, leadId: null, title, body })),
  );
  return { created: managers.length };
}

// A rep's alerts, newest first (+ unread count).
export async function listAlerts(tx: Tx, tenantId: string, repId: string): Promise<{ alerts: AlertRow[]; unread: number }> {
  const rows = await tx.select().from(canvassAlert).where(eq(canvassAlert.repId, repId)).orderBy(desc(canvassAlert.createdAt));
  return { alerts: rows.map(toRow), unread: rows.filter((r) => r.readAt === null).length };
}

// Flip one unread alert to read (only the owner's). Returns whether a row changed.
export async function markAlertRead(tx: Tx, tenantId: string, alertId: string, repId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(canvassAlert)
    .set({ readAt: now })
    .where(and(eq(canvassAlert.id, alertId), eq(canvassAlert.repId, repId), isNull(canvassAlert.readAt)))
    .returning({ id: canvassAlert.id });
  return rows.length > 0;
}

// Flip all the caller's unread alerts to read. Returns how many changed.
export async function markAllAlertsRead(tx: Tx, tenantId: string, repId: string, now: Date): Promise<number> {
  const rows = await tx
    .update(canvassAlert)
    .set({ readAt: now })
    .where(and(eq(canvassAlert.repId, repId), isNull(canvassAlert.readAt)))
    .returning({ id: canvassAlert.id });
  return rows.length;
}
