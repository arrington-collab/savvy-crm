import { buildDigestMessage, buildRecoveryLine, buildCalibrationLine, computeCalibration, summarizeAgentCoverage } from "@savvy/core";
import { adminDb, computeTaskExceptions, getCreditRecoverySummary, getCalibrationInputs, loadAgentCoverageWindow, recordAgentRun, user, eq, and } from "@savvy/db";
import type { SmsSender, EmailSender } from "@savvy/integrations";
import { getEmailSender } from "@savvy/integrations";
import { getTenantSms } from "./telephony";
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
  const exceptionBlock = [msg.body, recoveryLine, calibrationLine].filter(Boolean).join("\n");
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
    const email = deps.email ?? getEmailSender({ gmailConnectionId: null });
    try {
      await email.sendEmail({ to: owner.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: msg.subject, html: `<p>${body}</p>` });
    } catch {
      /* fail-soft: no email creds */
    }
  }

  await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", modelUsed });
  return { sent: 1, count: msg.count };
}
