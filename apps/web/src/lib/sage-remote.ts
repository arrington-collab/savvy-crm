import "server-only";
import {
  parseSageCommand,
  buildSageDigestText,
  describeSageItem,
  requiresConfirm,
  confirmPrompt,
  parseEstimateConfig,
  type SageActionKind,
  type SageDigestItem,
} from "@savvy/core";
import {
  withTenant,
  tenant,
  eq,
  sendInvoice,
  StripeNotConnectedError,
  userByPhone,
  confirmPhoneVerification,
  loadSageActionables,
  saveSageDigest,
  getActiveSageDigest,
  recordSageRemoteAction,
  findResolvedAction,
  getPendingConfirm,
  resolvePendingConfirm,
} from "@savvy/db";
import { inngest } from "@savvy/agents";
import { answerSageFreeText } from "./sage-freetext";

type Reply = { reply: string } | null;

/** Persisted digest rows store action as a plain string; narrow it back for the pure helpers. */
function toItem(row: { kind: string; entityId: string; jobId: string | null; title: string; detail: string; action: string | null; confirmAmountCents: number | null }): SageDigestItem {
  return { ...row, action: (row.action as SageActionKind | null) };
}

function formatTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(date);
}

/**
 * Execute one exception action by its UNDERLYING tenant-explicit trigger — the
 * inbound webhook has no Clerk session, so the "use server" card actions can't
 * be reused directly. Only the two v1-surfaced actions are handled.
 */
export async function dispatchSageAction(tenantId: string, item: SageDigestItem): Promise<{ ok: boolean; message: string }> {
  const who = item.title || "the customer";
  switch (item.action) {
    case "approve_estimate":
      try {
        await inngest.send({ name: "estimate/send.requested", data: { tenantId, estimateId: item.entityId } });
      } catch (e) {
        console.error("sage approve_estimate send failed", e);
        return { ok: false, message: `Couldn't approve the estimate for ${who} — try the app.` };
      }
      return { ok: true, message: `Approved — estimate sent to ${who}.` };
    case "send_invoice":
      try {
        await sendInvoice({ tenantId, invoiceId: item.entityId });
      } catch (e) {
        if (e instanceof StripeNotConnectedError) return { ok: false, message: "Stripe isn't connected — can't send that invoice yet." };
        console.error("sage send_invoice failed", e);
        return { ok: false, message: `Couldn't send the invoice to ${who} — try the app.` };
      }
      try { await inngest.send({ name: "invoice/sent", data: { tenantId, invoiceId: item.entityId } }); } catch (e) { console.error(e); }
      return { ok: true, message: `Sent — invoice to ${who}.` };
    default:
      return { ok: false, message: "That action isn't available by text yet." };
  }
}

/**
 * Route an inbound SMS from a phone to the Sage command surface. Returns the
 * reply text (the caller sends it), or null when the message isn't a Sage
 * command from a verified owner (so ordinary inbound-SMS handling continues).
 * Every executed/blocked action is logged for evidence; unverified numbers can
 * never move past a 'rejected' record.
 */
export async function handleSageCommand(tenantId: string, opts: { from: string; body: string; twilioSid?: string }): Promise<Reply> {
  const cmd = parseSageCommand(opts.body);
  const now = new Date();

  // Verification is how a phone BECOMES an allowed owner number, so it runs
  // before the verified-owner gate. A failed/unknown code falls through (a
  // customer's stray 6-digit text must not be hijacked).
  if (cmd.type === "verify") {
    const res = await confirmPhoneVerification(tenantId, opts.from, cmd.code, now);
    return res ? { reply: "✅ Verified. Text HELP any time for your queue." } : null;
  }

  const owner = await userByPhone(tenantId, opts.from, { verifiedOnly: true });
  if (!owner) {
    // An action/confirm/detail attempt from an unverified number is logged as a
    // blocked (rejected) event and NEVER executed — the sage.remote_actions
    // invariant fails if any verified=false row is non-rejected. No reply: don't
    // disclose the queue to a stranger.
    if (cmd.type === "action" || cmd.type === "confirm" || cmd.type === "detail") {
      await recordSageRemoteAction({ tenantId, userId: null, phone: opts.from, kind: cmd.type, confirmationState: "rejected", verified: false, result: "blocked_unverified" });
    }
    return null;
  }

  const tz = await tenantTimezone(tenantId);

  if (cmd.type === "help") {
    const items = await loadSageActionables(tenantId);
    if (items.length === 0) return { reply: "All clear — nothing needs you right now. 🎉" };
    const numbered = items.map((it, i) => ({ ...it, n: i + 1 }));
    await saveSageDigest(tenantId, owner.id, numbered);
    return { reply: buildSageDigestText(items).body };
  }

  if (cmd.type === "detail" || cmd.type === "action") {
    const digest = await getActiveSageDigest(tenantId, owner.id);
    if (!digest) return { reply: "No active queue — text HELP for your latest." };
    const row = digest.items[cmd.n - 1];
    if (!row) return { reply: `No item ${cmd.n}. Text HELP for your queue.` };
    const item = toItem(row);

    if (cmd.type === "detail") return { reply: describeSageItem(item, cmd.n) };

    // action
    const already = await findResolvedAction(tenantId, digest.id, cmd.n);
    if (already) return { reply: `Already done at ${formatTime(already.resolvedAt, tz)}.` };
    if (!item.action) return { reply: describeSageItem(item, cmd.n) };

    const cfg = await estimateConfig(tenantId);
    if (requiresConfirm(item, cfg)) {
      await recordSageRemoteAction({ tenantId, userId: owner.id, phone: opts.from, digestId: digest.id, n: cmd.n, kind: item.kind, exceptionRef: item.entityId, action: item.action, confirmationState: "pending", verified: true });
      return { reply: confirmPrompt(item) };
    }
    const res = await dispatchSageAction(tenantId, item);
    await recordSageRemoteAction({ tenantId, userId: owner.id, phone: opts.from, digestId: digest.id, n: cmd.n, kind: item.kind, exceptionRef: item.entityId, action: item.action, confirmationState: "immediate", verified: true, result: res.ok ? "executed" : "failed", resolvedAt: res.ok ? new Date() : null });
    return { reply: res.message };
  }

  if (cmd.type === "confirm") {
    const pend = await getPendingConfirm(tenantId, owner.id);
    if (!pend) return { reply: "Nothing to confirm right now." };
    if (!cmd.ok) {
      await resolvePendingConfirm(tenantId, pend.id, "rejected", "canceled", new Date());
      return { reply: "Canceled." };
    }
    const item = await pendingItem(tenantId, owner.id, pend);
    const res = await dispatchSageAction(tenantId, item);
    await resolvePendingConfirm(tenantId, pend.id, "confirmed", res.ok ? "executed" : "failed", new Date());
    return { reply: res.message };
  }

  // freetext → cited Sage answer
  return { reply: await answerSageFreeText(tenantId, cmd.text) };
}

async function pendingItem(
  tenantId: string,
  userId: string,
  pend: { digestId: string | null; n: number | null; action: string | null; exceptionRef: string | null; kind: string },
): Promise<SageDigestItem> {
  // Prefer the live digest row (nice title); fall back to the pending record.
  if (pend.n) {
    const digest = await getActiveSageDigest(tenantId, userId);
    const row = digest?.items[pend.n - 1];
    if (row) return toItem(row);
  }
  return { kind: pend.kind, entityId: pend.exceptionRef ?? "", jobId: null, title: "", detail: "", action: pend.action as SageActionKind | null, confirmAmountCents: null };
}

async function tenantTimezone(tenantId: string): Promise<string> {
  const [t] = await withTenant(tenantId, (tx) => tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, tenantId)));
  return t?.timezone ?? "America/Phoenix";
}

async function estimateConfig(tenantId: string): Promise<{ approvalThresholdCents: number | null }> {
  const [t] = await withTenant(tenantId, (tx) => tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)));
  return parseEstimateConfig((t?.settings as { estimate?: unknown } | undefined)?.estimate);
}
