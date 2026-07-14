// Customer for Life slice 1: the calendar writes. Every admission decision is
// the PURE governor's (core); this layer persists the outcome — including the
// refusals and displacements, which are ledger rows the relationship.governor
// evidence reads. Senders require a touchId: rogue sends are structurally
// impossible, not merely discouraged.

import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { tenant, customer, relationshipTouch } from "../schema/index";
import { governTouchRequest, type ExistingTouch } from "@savvy/core";

const DEFAULT_CAP_PER_YEAR = 5;

function capFor(settings: unknown): number {
  const cap = (settings as { relationship?: { touchCapPerYear?: number } } | null)?.relationship?.touchCapPerYear;
  return typeof cap === "number" && cap > 0 ? cap : DEFAULT_CAP_PER_YEAR;
}

export type ScheduleTouchResult =
  | { touchId: string; existing?: boolean; displaced?: string }
  | { scheduled: false; reason: "opt_out" | "cap_exceeded" | "customer_not_found" };

export async function scheduleRelationshipTouch(input: {
  tenantId: string;
  customerId: string;
  program: string;
  channel: string;
  scheduledFor: Date;
  templateVersion?: string | null;
  sourceRef?: string | null;
  now?: Date;
}): Promise<ScheduleTouchResult> {
  const now = input.now ?? new Date();
  return withTenant(input.tenantId, async (tx) => {
    const [cust] = await tx.select({
      smsOptOut: customer.smsOptOut, emailOptOut: customer.emailOptOut, mailOptOut: customer.mailOptOut,
    }).from(customer).where(eq(customer.id, input.customerId));
    if (!cust) return { scheduled: false as const, reason: "customer_not_found" as const };

    // Idempotency: a program+sourceRef pair schedules exactly once.
    if (input.sourceRef) {
      const [existing] = await tx.select({ id: relationshipTouch.id }).from(relationshipTouch)
        .where(and(
          eq(relationshipTouch.customerId, input.customerId),
          eq(relationshipTouch.program, input.program),
          eq(relationshipTouch.sourceRef, input.sourceRef),
          isNull(relationshipTouch.suppressedReason),
        ));
      if (existing) return { touchId: existing.id, existing: true };
    }

    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, input.tenantId));
    const optOuts: Partial<Record<string, boolean>> = {
      text: cust.smsOptOut, email: cust.emailOptOut, postcard: cust.mailOptOut, letter: cust.mailOptOut,
    };

    const windowStart = new Date(now.getTime() - 365.25 * 86_400_000);
    const rows = await tx.select().from(relationshipTouch)
      .where(and(
        eq(relationshipTouch.customerId, input.customerId),
        isNull(relationshipTouch.suppressedReason),
        gte(relationshipTouch.scheduledFor, windowStart),
      ));
    const existing: ExistingTouch[] = rows.map((r) => ({
      program: r.program, channel: r.channel, scheduledFor: r.scheduledFor, sentAt: r.sentAt,
    }));

    const verdict = governTouchRequest(
      { program: input.program, channel: input.channel, scheduledFor: input.scheduledFor },
      existing,
      { capPerYear: capFor(t?.settings), optOuts },
      now,
    );

    if (!verdict.admit) {
      // The refusal IS a ledger row — evidence reads suppressions too.
      await tx.insert(relationshipTouch).values({
        tenantId: input.tenantId, customerId: input.customerId, program: input.program,
        channel: input.channel, scheduledFor: input.scheduledFor,
        suppressedReason: verdict.reason, sourceRef: input.sourceRef ?? null,
      });
      return { scheduled: false as const, reason: verdict.reason };
    }

    let displaced: string | undefined;
    if (verdict.displace) {
      const [row] = await tx.update(relationshipTouch)
        .set({ suppressedReason: "displaced" })
        .where(and(
          eq(relationshipTouch.customerId, input.customerId),
          eq(relationshipTouch.program, verdict.displace.program),
          isNull(relationshipTouch.sentAt),
          isNull(relationshipTouch.suppressedReason),
        ))
        .returning({ program: relationshipTouch.program });
      displaced = row?.program;
    }

    const [created] = await tx.insert(relationshipTouch).values({
      tenantId: input.tenantId, customerId: input.customerId, program: input.program,
      channel: input.channel, scheduledFor: input.scheduledFor,
      templateVersion: input.templateVersion ?? null, sourceRef: input.sourceRef ?? null,
    }).returning({ id: relationshipTouch.id });
    return { touchId: created!.id, ...(displaced ? { displaced } : {}) };
  });
}

export async function markTouchSent(input: { tenantId: string; touchId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(relationshipTouch)
    .set({ sentAt: sql`coalesce(${relationshipTouch.sentAt}, now())` })
    .where(eq(relationshipTouch.id, input.touchId)));
}

export async function markTouchSuppressed(input: { tenantId: string; touchId: string; reason: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(relationshipTouch)
    .set({ suppressedReason: input.reason })
    .where(and(eq(relationshipTouch.id, input.touchId), isNull(relationshipTouch.sentAt))));
}

export async function listDueTouches(tenantId: string, now: Date): Promise<(typeof relationshipTouch.$inferSelect)[]> {
  return withTenant(tenantId, (tx) => tx.select().from(relationshipTouch)
    .where(and(
      isNull(relationshipTouch.sentAt),
      isNull(relationshipTouch.suppressedReason),
      sql`${relationshipTouch.scheduledFor} <= ${now.toISOString()}::timestamptz`,
    )));
}

/** relationship.governor evidence: customers whose SENT touches exceed the cap
 *  in the rolling year. Must be empty — any hit means a path bypassed the calendar. */
export async function governorCapViolations(tenantId: string, capPerYear = DEFAULT_CAP_PER_YEAR): Promise<{ customerId: string; sentInWindow: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select({
      customerId: relationshipTouch.customerId,
      sentInWindow: sql<number>`count(*)::int`,
    }).from(relationshipTouch)
      .where(and(
        sql`${relationshipTouch.sentAt} is not null`,
        gte(relationshipTouch.sentAt, sql`now() - interval '365 days'` as unknown as Date),
      ))
      .groupBy(relationshipTouch.customerId)
      .having(sql`count(*) > ${capPerYear}`);
    return rows;
  });
}
