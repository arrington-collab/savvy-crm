import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { parsePartnerLedgerConfig, type PartnerLedgerKind } from "@savvy/core";
import { withTenant, type Tx } from "../tenant";
import { tenant } from "../schema/tenancy";
import { lead } from "../schema/crm";
import { partnerLedgerEntry } from "../schema/partner";
import { inspection } from "../schema/inspection";
import { referralPayment } from "../schema/finance";

/**
 * Partner Ledger slice 2 — cost accrual. Every accrual is idempotent on
 * (tenant, source_ref): inline hooks (inspection completion, friend rule) and
 * the hourly self-healing sweep can both fire without double-counting.
 */

export type AccrualInput = {
  partnerId: string;
  kind: PartnerLedgerKind;
  amountCents: number;
  sourceRef: string;
  occurredAt?: Date;
  note?: string | null;
  createdByUserId?: string | null;
  direction?: "cost" | "revenue";
};

export async function accrueLedgerEntryTx(tx: Tx, tenantId: string, input: AccrualInput): Promise<{ created: boolean }> {
  const rows = await tx.insert(partnerLedgerEntry).values({
    tenantId,
    partnerId: input.partnerId,
    kind: input.kind,
    direction: input.direction ?? "cost",
    amountCents: input.amountCents,
    sourceRef: input.sourceRef,
    occurredAt: input.occurredAt ?? new Date(),
    note: input.note ?? null,
    createdByUserId: input.createdByUserId ?? null,
  }).onConflictDoNothing().returning({ id: partnerLedgerEntry.id });
  return { created: rows.length > 0 };
}

/** Standard cost for a completed inspection on a partner-sourced lead (config, default $200). */
export async function accrueInspectionStandardCostTx(
  tx: Tx,
  tenantId: string,
  inspectionId: string,
): Promise<{ created: boolean }> {
  const [row] = await tx.select({ partnerId: lead.partnerId, completedAt: inspection.completedAt })
    .from(inspection)
    .innerJoin(lead, eq(lead.id, inspection.leadId))
    .where(and(eq(inspection.tenantId, tenantId), eq(inspection.id, inspectionId)));
  if (!row?.partnerId || !row.completedAt) return { created: false };

  const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const cfg = parsePartnerLedgerConfig((t?.settings as { partnerLedger?: unknown } | null)?.partnerLedger);
  return accrueLedgerEntryTx(tx, tenantId, {
    partnerId: row.partnerId,
    kind: "inspection_standard",
    amountCents: cfg.inspectionStandardCostCents,
    sourceRef: `inspection:${inspectionId}`,
    occurredAt: row.completedAt,
  });
}

/**
 * Self-healing sweep (rides the hourly partner sweep). Three idempotent passes:
 * completed partner-sourced inspections, fixed-free-today findings on partnered
 * leads, and approved/paid referral payments on partner-attributed leads.
 * Normally finds nothing — the inline hooks already accrued.
 */
export async function sweepPartnerLedgerAccruals(tenantId: string): Promise<{ accrued: number }> {
  return withTenant(tenantId, async (tx) => {
    let accrued = 0;

    // 1) Completed inspections on partner-sourced leads.
    const inspections = await tx.select({ id: inspection.id })
      .from(inspection)
      .innerJoin(lead, eq(lead.id, inspection.leadId))
      .where(and(
        eq(inspection.tenantId, tenantId),
        isNotNull(inspection.completedAt),
        isNotNull(lead.partnerId),
        sql`not exists (select 1 from ${partnerLedgerEntry} e
              where e.tenant_id = ${tenantId} and e.source_ref = 'inspection:' || ${inspection.id})`,
      ));
    for (const i of inspections) {
      const r = await accrueInspectionStandardCostTx(tx, tenantId, i.id);
      if (r.created) accrued++;
    }

    // 2) Friend-rule free repairs on partnered leads (finding → zone → inspection → lead).
    const findings = await tx.execute(sql`
      select f.id, f.repair_estimate_cents, f.created_at, l.partner_id
        from inspection_finding f
        join inspection_zone z on z.id = f.inspection_zone_id
        join inspection i on i.id = z.inspection_id
        join lead l on l.id = i.lead_id
       where f.tenant_id = ${tenantId}
         and f.disposition = 'fixed_free_today'
         and f.repair_estimate_cents is not null
         and l.partner_id is not null
         and not exists (select 1 from partner_ledger_entry e
               where e.tenant_id = ${tenantId} and e.source_ref = 'finding:' || f.id)
    `);
    for (const f of findings.rows as Array<{ id: string; repair_estimate_cents: number; created_at: Date; partner_id: string }>) {
      const r = await accrueLedgerEntryTx(tx, tenantId, {
        partnerId: f.partner_id,
        kind: "free_repair",
        amountCents: f.repair_estimate_cents,
        sourceRef: `finding:${f.id}`,
        occurredAt: new Date(f.created_at),
      });
      if (r.created) accrued++;
    }

    // 3) Approved/paid referral fees whose lead is partner-attributed.
    const fees = await tx.select({
      id: referralPayment.id, amountCents: referralPayment.amountCents,
      createdAt: referralPayment.createdAt, partnerId: lead.partnerId,
    })
      .from(referralPayment)
      .innerJoin(lead, eq(lead.id, referralPayment.leadId))
      .where(and(
        eq(referralPayment.tenantId, tenantId),
        inArray(referralPayment.status, ["approved", "paid"]),
        isNotNull(lead.partnerId),
        sql`not exists (select 1 from ${partnerLedgerEntry} e
              where e.tenant_id = ${tenantId} and e.source_ref = 'referral_payment:' || ${referralPayment.id})`,
      ));
    for (const p of fees) {
      const r = await accrueLedgerEntryTx(tx, tenantId, {
        partnerId: p.partnerId!,
        kind: "referral_fee",
        amountCents: p.amountCents,
        sourceRef: `referral_payment:${p.id}`,
        occurredAt: p.createdAt,
      });
      if (r.created) accrued++;
    }

    return { accrued };
  });
}

/** Phone-friendly quick-log: amount + note + partner. A log, not accounting. */
export async function logPartnerExpense(
  tenantId: string,
  input: { partnerId: string; amountCents: number; note: string; createdByUserId?: string | null },
): Promise<{ entryId: string }> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Expense amount must be a positive amount in cents");
  }
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(partnerLedgerEntry).values({
      tenantId,
      partnerId: input.partnerId,
      kind: "expense",
      direction: "cost",
      amountCents: input.amountCents,
      sourceRef: `expense:${crypto.randomUUID()}`,
      note: input.note || null,
      createdByUserId: input.createdByUserId ?? null,
    }).returning({ id: partnerLedgerEntry.id });
    return { entryId: row!.id };
  });
}

/** Trailing-7-day expense sum for the owner digest. */
export async function partnerExpenseWeeklySum(tenantId: string, now: Date): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const [row] = await tx.select({ sum: sql<number>`coalesce(sum(${partnerLedgerEntry.amountCents}), 0)::int` })
      .from(partnerLedgerEntry)
      .where(and(
        eq(partnerLedgerEntry.tenantId, tenantId),
        eq(partnerLedgerEntry.kind, "expense"),
        gte(partnerLedgerEntry.occurredAt, since),
      ));
    return row?.sum ?? 0;
  });
}
