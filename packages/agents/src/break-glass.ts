import { buildBreakGlassMessage } from "@savvy/core";
import { adminDb, recordAgentRun, taskException, taskRegistry, user, and, eq, inArray, isNull } from "@savvy/db";
import type { SmsSender, EmailSender } from "@savvy/integrations";
import { getEmailSender } from "@savvy/integrations";
import { getTenantSms } from "./telephony";

type SmsDep = { sender: SmsSender; from: string } | null;
export interface BreakGlassDeps {
  sms?: SmsDep; // undefined = resolve per-tenant; null = no SMS
  email?: EmailSender;
  now?: Date;
}

/**
 * Pages the owner IMMEDIATELY for open break-glass exceptions — the only alert
 * that interrupts the day instead of waiting for the digest. Fires once per
 * exception (break_glass_notified_at is the guard), so the sweep can call this
 * every run without re-paging. SMS + email are fail-soft (mock in dev / no
 * creds). The agent_run is the proof-of-page. Called by the health sweep right
 * after exceptions are reconciled.
 */
export async function pageBreakGlass(tenantId: string, deps: BreakGlassDeps = {}): Promise<{ paged: number }> {
  const now = deps.now ?? new Date();

  // Open, break-glass, not-yet-paged exceptions with their task name + dollar impact.
  const rows = await adminDb
    .select({ id: taskException.id, taskId: taskException.taskId, dollarImpactCents: taskException.dollarImpactCents, title: taskRegistry.name })
    .from(taskException)
    .innerJoin(taskRegistry, eq(taskRegistry.id, taskException.taskId))
    .where(and(
      eq(taskException.tenantId, tenantId),
      eq(taskException.breakGlass, true),
      isNull(taskException.breakGlassNotifiedAt),
      isNull(taskException.resolvedAt),
    ));

  const msg = buildBreakGlassMessage(rows.map((r) => ({ taskId: r.taskId, title: r.title, dollarImpactCents: r.dollarImpactCents })));
  if (!msg) return { paged: 0 };

  const [owner] = await adminDb
    .select({ phone: user.phone, email: user.email })
    .from(user)
    .where(and(eq(user.tenantId, tenantId), eq(user.role, "owner")))
    .limit(1);

  if (owner?.phone) {
    const smsDep: SmsDep = deps.sms !== undefined ? deps.sms : await getTenantSms(tenantId).catch(() => null);
    if (smsDep) {
      try {
        await smsDep.sender.sendSms({ to: owner.phone, from: smsDep.from, body: msg.body });
      } catch {
        /* fail-soft: no SMS creds */
      }
    }
  }
  if (owner?.email) {
    const email = deps.email ?? getEmailSender({ gmailConnectionId: null });
    try {
      await email.sendEmail({ to: owner.email, from: process.env.EMAIL_FROM ?? "noreply@example.com", subject: msg.subject, html: `<p>${msg.body}</p>` });
    } catch {
      /* fail-soft: no email creds */
    }
  }

  // Mark paged so the next sweep doesn't re-interrupt the owner for the same exceptions.
  await adminDb
    .update(taskException)
    .set({ breakGlassNotifiedAt: now, updatedAt: now })
    .where(inArray(taskException.id, rows.map((r) => r.id)));

  await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "ops.break_glass", status: "ok" });
  return { paged: rows.length };
}
