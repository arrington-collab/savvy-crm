import { buildDigestMessage, buildRecoveryLine, buildCalibrationLine, buildPartnerExpenseLine, buildPartnerQuarterlyLine, buildBlitzLine, buildFillLine, buildValuationLine, buildValueLevers, parseValuationConfig, buildMaintenanceLine, computeCalibration, summarizeAgentCoverage, type ValuationSnapshotResult } from "@savvy/core";
import { adminDb, computeTaskExceptions, getCreditRecoverySummary, getCalibrationInputs, loadAgentCoverageWindow, partnerExpenseWeeklySum, freshQuarterlyReportCount, blitzWeekStats, fillWeekStats, listValuationSnapshots, maintenanceChurnStats, recordAgentRun, user, eq, and, tenant as tenantForValuation } from "@savvy/db";
import type { SmsSender, EmailSender } from "@savvy/integrations";
import { getTenantSms } from "./telephony";
import { getTenantEmail } from "./email";
import { composeShiftReport, type ShiftAiClient } from "./shift-report";

type SmsDep = { sender: SmsSender; from: string } | null;
export interface DigestDeps {
  sms?: SmsDep; // undefined = resolve per-tenant; null = no SMS
  email?: EmailSender;
  aiClient?: ShiftAiClient; // undefined = real gateway; injectable for tests
}

/**
 * Sends one tenant's exception digest to the owner (batched attention). Suppresses
 * empty digests. SMS + email are fail-soft (no creds in dev / mock in prod). The
 * agent_run is the proof-of-send. break_glass (immediate interrupt on >=$10k /
 * <48h) is deferred until exceptions carry dollar/deadline impact.
 */
export async function sendTenantDigest(tenantId: string, deps: DigestDeps = {}): Promise<{ sent: number; count: number }> {
  const exceptions = await computeTaskExceptions(tenantId);
  const msg = buildDigestMessage(exceptions);
  if (!msg) return { sent: 0, count: 0 }; // suppress: nothing to say (and burn no model call)

  const now = new Date();
  const window = { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
  const recoverySummary = await getCreditRecoverySummary(tenantId, window);
  const recoveryLine = buildRecoveryLine(recoverySummary);
  // Slice 5: ride the owner digest with the score-calibration line once it's active
  // (≥50 resolved leads); below that it stays silent rather than surfacing noise.
  const calibrationLine = buildCalibrationLine(computeCalibration(await getCalibrationInputs(tenantId)));
  // S4: a first-person shift report over the real 24h agent coverage, prepended to
  // the actionable exception lines. Fail-soft — the model can only ever be replaced
  // by a factual template, never block the digest.
  const coverage = summarizeAgentCoverage(await loadAgentCoverageWindow(tenantId, window.start), now);
  const { narrative, modelUsed } = await composeShiftReport(coverage, deps.aiClient);
  // Partner Ledger slice 2: the weekly partner-expense sum rides the digest
  // (silent at zero, fail-soft — a ledger hiccup never blocks the digest).
  const partnerExpenseLine = buildPartnerExpenseLine(await partnerExpenseWeeklySum(tenantId, now).catch(() => 0));
  const partnerQuarterlyLine = buildPartnerQuarterlyLine(await freshQuarterlyReportCount(tenantId, now).catch(() => 0));
  const blitzLine = buildBlitzLine(await blitzWeekStats(tenantId, now).catch(() => ({ blitzes: 0, spendCents: 0, mobilizationLeads: 0, blitzedJobs12mo: 0, mobilizationRoofs12mo: 0 })));
  const fillLine = buildFillLine(await fillWeekStats(tenantId, now).catch(() => ({ gaps: 0, playsSent: 0, conversions: 0, idleCrewDaysRecovered: 0, pendingCards: 0 })));
  const maintenanceLine = buildMaintenanceLine(await maintenanceChurnStats(tenantId, now).catch(() => ({ activeCount: 0, newThisMonth30d: 0, canceledThisMonth30d: 0, topCancelReason: null, mrrCents: 0 })));
  // Owner's Room S3: the MONTHLY value pulse — rides the digest only on the
  // first day after a fresh snapshot lands (never a daily nag). Fail-soft.
  const valuationLine = await (async () => {
    try {
      const snaps = await listValuationSnapshots(tenantId, 5);
      const latest = snaps[0];
      if (!latest || now.getTime() - latest.computedAt.getTime() > 24 * 3_600_000) return null;
      const shape = (r: typeof latest) => ({
        periodKey: r.periodKey, status: r.status,
        valueLowCents: r.valueLowCents, valueLikelyCents: r.valueLikelyCents, valueHighCents: r.valueHighCents,
        adjustments: (r.adjustments ?? []) as { key: string; deltaLow: number; deltaHigh: number; rationale: string }[],
        inputQuality: r.inputQuality as never,
      });
      const prior = snaps.slice(3).find((sn) => sn.status === "ok") ?? snaps[1] ?? null;
      const [t] = await adminDb.select({ settings: tenantForValuation.settings }).from(tenantForValuation).where(eq(tenantForValuation.id, tenantId));
      const config = parseValuationConfig((t?.settings as { valuation?: unknown } | null)?.valuation);
      const levers = buildValueLevers({
        ...shape(latest), reasons: undefined, sdeCents: latest.sdeCents, bandKey: null,
        baseMultipleLow: 0, baseMultipleHigh: 0,
        multipleLow: latest.multipleLow ?? 0, multipleHigh: latest.multipleHigh ?? 0,
        inputQuality: (latest.inputQuality ?? { real: 0, estimated: 0, missing: 0, flags: {} }) as ValuationSnapshotResult["inputQuality"],
        methodologyVersion: latest.methodologyVersion,
        status: latest.status as "ok" | "insufficient_data",
      }, config);
      return buildValuationLine(shape(latest), prior ? shape(prior) : null, levers);
    } catch {
      return null;
    }
  })();
  const exceptionBlock = [msg.body, recoveryLine, calibrationLine, partnerExpenseLine, partnerQuarterlyLine, blitzLine, fillLine, maintenanceLine, valuationLine].filter(Boolean).join("\n");
  const body = `${narrative}\n\n${exceptionBlock}`;

  const [owner] = await adminDb
    .select({ phone: user.phone, email: user.email })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), eq(user.role, "owner")))
    .limit(1);

  if (owner?.phone) {
    const smsDep: SmsDep = deps.sms !== undefined ? deps.sms : await getTenantSms(tenantId).catch(() => null);
    if (smsDep) {
      try {
        await smsDep.sender.sendSms({ to: owner.phone, from: smsDep.from, body });
      } catch {
        /* fail-soft: no SMS creds */
      }
    }
  }
  if (owner?.email) {
    const email = deps.email ?? (await getTenantEmail(tenantId, { gmailConnectionId: null }));
    try {
      await email.sendEmail({ to: owner.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: msg.subject, html: `<p>${body}</p>` });
    } catch {
      /* fail-soft: no email creds */
    }
  }

  await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", modelUsed });
  return { sent: 1, count: msg.count };
}
