import "server-only";
import { withTenant, adminDb, tenant, invoice, payment, agentRun, inArray, gte, and, eq, sql, desc } from "@savvy/db";
import { summarizeMoneyStrip, summarizeAgentCoverage, summarizeMinutesSaved, parseFinanceConfig, type Agent, type MoneyStrip, type AgentCoverage, type MinutesSaved } from "@savvy/core";
import { getTenantId } from "./tenant";
import { loadTenantRollup } from "./scoreboard-queries";

/** Active tenant's display name + timezone (one read; tenant.settings has no RLS → adminDb). */
export async function getTenantIdentity(): Promise<{ name: string; timezone: string }> {
  const tenantId = await getTenantId();
  const [t] = await adminDb.select({ name: tenant.name, settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings ?? {}) as { finance?: unknown };
  return { name: t?.name ?? "Your company", timezone: parseFinanceConfig(settings.finance).timezone };
}

const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

export type TodayMoney = MoneyStrip;
export type TodayDigest = { totalActions: number; activeAgents: number; perAgent: AgentCoverage[]; minutesSaved: MinutesSaved; since: Date };

/**
 * The money strip + "while you were out" digest for the Today console. Reads are
 * tenant-scoped; the aging/per-job math and the per-agent rollup live in tested
 * pure functions in @savvy/core. GM stays null (cell 14) → the page renders "—".
 */
export async function getTodayMoney(now: Date = new Date()): Promise<TodayMoney> {
  const tenantId = await getTenantId();
  const weekAgo = new Date(now.getTime() - WEEK_MS);

  const [invoices, cashRows, rollup] = await Promise.all([
    withTenant(tenantId, (tx) =>
      tx
        .select({ amountDue: invoice.amountDue, amountPaid: invoice.amountPaid, dueAt: invoice.dueAt })
        .from(invoice)
        .where(and(eq(invoice.tenantId, tenantId), inArray(invoice.status, ["sent", "overdue"]))),
    ),
    withTenant(tenantId, (tx) =>
      tx
        .select({ total: sql<string>`coalesce(sum(${payment.amount}), 0)` })
        .from(payment)
        .where(and(eq(payment.tenantId, tenantId), gte(payment.receivedAt, weekAgo))),
    ),
    loadTenantRollup(),
  ]);

  return summarizeMoneyStrip({
    openInvoices: invoices.map((i) => ({
      amountDueCents: i.amountDue ?? 0,
      amountPaidCents: i.amountPaid ?? 0,
      dueAt: i.dueAt ? new Date(i.dueAt as unknown as string) : null,
    })),
    cashCollectedWkCents: Number(cashRows[0]?.total ?? 0),
    rollup: rollup ? { founderMinutes30d: rollup.founderMinutes30d, jobs30d: rollup.jobs30d } : null,
    now,
  });
}

/** The "while you were out" panel: agent_run activity over the last 24h, grouped per agent. */
export async function getTodayDigest(now: Date = new Date()): Promise<TodayDigest> {
  const tenantId = await getTenantId();
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const runs = await withTenant(tenantId, (tx) =>
    tx
      .select({ agent: agentRun.agent, status: agentRun.status, taskKey: agentRun.taskKey, modelUsed: agentRun.modelUsed, costCents: agentRun.costCents, startedAt: agentRun.startedAt })
      .from(agentRun)
      .where(and(eq(agentRun.tenantId, tenantId), gte(agentRun.startedAt, dayAgo)))
      .orderBy(desc(agentRun.startedAt)),
  );
  const lite = runs.map((r) => ({ agent: r.agent as Agent, status: r.status, modelUsed: r.modelUsed, costCents: r.costCents, startedAt: new Date(r.startedAt as unknown as string) }));
  const perAgent = summarizeAgentCoverage(lite, now);
  const minutesSaved = summarizeMinutesSaved(runs.map((r) => ({ taskKey: r.taskKey, status: r.status })));
  return {
    totalActions: lite.length,
    activeAgents: new Set(lite.map((r) => r.agent)).size,
    perAgent: perAgent.filter((a) => a.total > 0),
    minutesSaved,
    since: dayAgo,
  };
}
