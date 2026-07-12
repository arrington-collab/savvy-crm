import {
  getMaterialOrderSnapshot,
  saveGuardedSupplierInvoice,
  createCreditRequest,
  recordAgentRun,
  gateAgentAutomation,
  withTenant,
  supplierInvoice,
  tenant,
  eq,
  listOpenSentCreditRequests,
  markCreditRequestCredited,
  listAllowedDomains,
} from "@savvy/db";
import {
  matchInvoiceLines,
  computeLineOverage,
  shouldAutoSendCredit,
  parseFinanceConfig,
  matchCreditMemo,
  resolveSupplierRecipient,
  isRecipientAllowed,
  SUPPLIER_SELF_DOMAINS,
  type SupplierInvoiceLine,
  type SnapshotLine,
} from "@savvy/core";
import { getTenantEmail } from "../email";
import { inngest } from "../client";

// The finance persona task key for the guard checklist item.
const GUARD_TASK_KEY = "close-out-133";

type ParsedInvoice = {
  jobId: string | null;
  supplierName: string | null;
  invoiceNumber: string | null;
  parseConfidence: number | null;
  totalCents: number | null;
  lines: SupplierInvoiceLine[];
  senderEmail: string | null;
};

type PriceGuardConfig = {
  minOverageCents: number;
  overagePct: number;
  autoSendMinCents: number;
  highConfidence: number;
};

export type PriceGuardDeps = {
  loadInvoice: (tenantId: string, id: string) => Promise<ParsedInvoice>;
  loadSnapshot: (tenantId: string, jobId: string) => Promise<SnapshotLine[]>;
  loadConfig: (tenantId: string) => Promise<PriceGuardConfig>;
  saveGuarded: (tenantId: string, id: string, lines: SupplierInvoiceLine[]) => Promise<void>;
  createCredit: (
    tenantId: string,
    input: {
      supplierInvoiceId: string;
      jobId: string | null;
      supplierName: string | null;
      claimedCents: number;
      status: "sent" | "drafted";
      evidence: unknown;
      emailMessageId?: string | null;
    },
  ) => Promise<{ id: string }>;
  sendEmail: (opts: { to: string; subject: string; html: string }) => Promise<{ id: string }>;
  recordRun: (opts: { tenantId: string; jobId: string | null; status: "ok" | "error"; error?: string | null }) => Promise<void>;
  gate: (tenantId: string, jobId: string) => Promise<{ proceed: boolean; level: string }>;
  resolveRecipient: (senderEmail: string | null) => string | null;
  loadAllowedDomains: (tenantId: string) => Promise<string[]>;
  logAudit: (o: { tenantId: string; recipientDomain: string; claimedCents: number; outcome: "sent" | "blocked_not_allowlisted" }) => void;
  raiseDraftCard: (
    tenantId: string,
    args: { supplierInvoiceId: string; supplierName: string | null; claimedCents: number },
  ) => Promise<void>;
};

type EvidenceLine = {
  description: string;
  quantity: number;
  unitBilledCents: number;
  expectedUnitCostCents: number | null;
  overageCents: number;
};

/** Professional, evidence-based supplier credit-request email. */
function buildCreditEmail(
  inv: ParsedInvoice,
  claimedCents: number,
  evidence: EvidenceLine[],
  to: string,
): { to: string; subject: string; html: string } {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const rows = evidence
    .map(
      (e) =>
        `<tr><td>${e.description}</td><td>${e.quantity}</td><td>${usd(e.unitBilledCents)}</td>` +
        `<td>${e.expectedUnitCostCents != null ? usd(e.expectedUnitCostCents) : "—"}</td><td>${usd(e.overageCents)}</td></tr>`,
    )
    .join("");
  return {
    to,
    subject: `Credit request — invoice ${inv.invoiceNumber ?? ""} (${usd(claimedCents)} overbilled)`,
    html:
      `<p>We identified an overbilling on invoice ${inv.invoiceNumber ?? ""} totaling <strong>${usd(claimedCents)}</strong>.</p>` +
      `<table><thead><tr><th>Item</th><th>Qty</th><th>Billed</th><th>Expected</th><th>Overage</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>` +
      `<p>Please issue a credit memo for ${usd(claimedCents)}. Thank you.</p>`,
  };
}

/**
 * Price-guard one parsed invoice: match lines → compute overages → persist guarded
 * state → gate auto-send → create credit request (sent or drafted). FAIL-SOFT: any
 * unhandled error returns guard_skipped and never throws.
 */
export async function priceGuardHandler(
  input: { tenantId: string; supplierInvoiceId: string },
  deps: PriceGuardDeps,
): Promise<{ status: "guarded" | "guard_skipped"; creditRequestId?: string | null; claimedCents: number }> {
  const { tenantId, supplierInvoiceId } = input;
  try {
    const inv = await deps.loadInvoice(tenantId, supplierInvoiceId);

    // Credit memos (negative total) are the recovery path — handled by Task 5.
    if ((inv.totalCents ?? 0) < 0) return { status: "guard_skipped", claimedCents: 0 };

    const cfg = await deps.loadConfig(tenantId);
    const snapshot = inv.jobId ? await deps.loadSnapshot(tenantId, inv.jobId) : [];
    const matches = matchInvoiceLines(inv.lines, snapshot);

    // Single pass: annotate each line with guard verdict fields AND accumulate claim totals.
    const guardedLines: SupplierInvoiceLine[] = [];
    let claimedCents = 0;
    let allOverageLinesMatched = true;
    const evidence: EvidenceLine[] = [];

    for (let i = 0; i < inv.lines.length; i++) {
      const line = inv.lines[i]!;
      const m = matches[i]!;
      const { overageCents, qualifies } = computeLineOverage(
        { unitBilledCents: line.unitBilledCents, quantity: line.quantity, expectedUnitCostCents: m.expectedUnitCostCents },
        cfg,
      );
      guardedLines.push({
        ...line,
        matchedItemKey: m.matchedItemKey,
        expectedUnitCostCents: m.expectedUnitCostCents,
        matchConfidence: m.matchConfidence,
        overageCents,
      });
      if (qualifies) {
        claimedCents += overageCents;
        if (m.matchedItemKey == null) allOverageLinesMatched = false;
        evidence.push({
          description: line.description,
          quantity: line.quantity,
          unitBilledCents: line.unitBilledCents,
          expectedUnitCostCents: m.expectedUnitCostCents,
          overageCents,
        });
      }
    }
    await deps.saveGuarded(tenantId, supplierInvoiceId, guardedLines);

    // No qualifying overages — guarded but nothing to claim.
    if (claimedCents <= 0) return { status: "guarded", creditRequestId: null, claimedCents: 0 };

    // Gate: no job → no automation check → draft only.
    const gate = inv.jobId
      ? await deps.gate(tenantId, inv.jobId)
      : { proceed: false, level: "no_job" };

    const recipient = deps.resolveRecipient(inv.senderEmail);
    const allowedDomains = await deps.loadAllowedDomains(tenantId);
    const allowed = recipient !== null && isRecipientAllowed(recipient, allowedDomains);
    const domainOf = (e: string) => e.slice(e.lastIndexOf("@") + 1);
    const autoSend =
      shouldAutoSendCredit({ claimedCents, parseConfidence: inv.parseConfidence, allOverageLinesMatched, cfg }) &&
      gate.proceed &&
      recipient !== null &&
      allowed;

    if (autoSend) {
      const email = await deps.sendEmail(buildCreditEmail(inv, claimedCents, evidence, recipient!));
      deps.logAudit({ tenantId, recipientDomain: domainOf(recipient!), claimedCents, outcome: "sent" });
      const cr = await deps.createCredit(tenantId, {
        supplierInvoiceId,
        jobId: inv.jobId,
        supplierName: inv.supplierName,
        claimedCents,
        status: "sent",
        evidence,
        emailMessageId: email.id,
      });
      await deps.recordRun({ tenantId, jobId: inv.jobId, status: "ok" });
      return { status: "guarded", creditRequestId: cr.id, claimedCents };
    }

    if (recipient !== null && allowedDomains.length > 0 && !allowed) {
      deps.logAudit({ tenantId, recipientDomain: domainOf(recipient), claimedCents, outcome: "blocked_not_allowlisted" });
    }

    // Draft: create credit request + surface to the Today card feed (query-driven via drafted status).
    const cr = await deps.createCredit(tenantId, {
      supplierInvoiceId,
      jobId: inv.jobId,
      supplierName: inv.supplierName,
      claimedCents,
      status: "drafted",
      evidence,
    });
    await deps.raiseDraftCard(tenantId, { supplierInvoiceId, supplierName: inv.supplierName, claimedCents });
    return { status: "guarded", creditRequestId: cr.id, claimedCents };
  } catch {
    return { status: "guard_skipped", claimedCents: 0 };
  }
}

export type RecoverDeps = {
  loadInvoice: (tenantId: string, id: string) => Promise<{ supplierName: string | null; totalCents: number | null }>;
  listOpen: (tenantId: string, supplierName: string | null) => Promise<{ id: string; supplierName: string | null; claimedCents: number }[]>;
  markCredited: (tenantId: string, id: string, recoveredCents: number) => Promise<void>;
  raiseReconcileCard: (tenantId: string, args: { supplierInvoiceId: string; supplierName: string | null; amountCents: number }) => Promise<void>;
};

/** Credit-memo recovery: match a negative-total invoice to one open sent request → credited. FAIL-SOFT. */
export async function recoverCreditMemoHandler(
  input: { tenantId: string; supplierInvoiceId: string },
  deps: RecoverDeps,
): Promise<{ status: "credited" | "reconcile" | "skipped" }> {
  const { tenantId, supplierInvoiceId } = input;
  try {
    const inv = await deps.loadInvoice(tenantId, supplierInvoiceId);
    if ((inv.totalCents ?? 0) >= 0) return { status: "skipped" };
    const amountCents = Math.abs(inv.totalCents ?? 0);
    const open = await deps.listOpen(tenantId, inv.supplierName);
    const matchId = matchCreditMemo({ supplierName: inv.supplierName, amountCents }, open);
    if (matchId) {
      await deps.markCredited(tenantId, matchId, amountCents);
      return { status: "credited" };
    }
    await deps.raiseReconcileCard(tenantId, { supplierInvoiceId, supplierName: inv.supplierName, amountCents });
    return { status: "reconcile" };
  } catch {
    return { status: "skipped" };
  }
}

// Per-tenant concurrency key so one tenant's invoice burst can't starve others' guarding.
export const priceGuardSupplierInvoice = inngest.createFunction(
  { id: "price-guard-supplier-invoice", concurrency: { limit: 5, key: "event.data.tenantId" }, retries: 2 },
  { event: "supplier-invoice/parsed" },
  async ({ event, step }) => {
    const { tenantId, supplierInvoiceId } = event.data as { tenantId: string; supplierInvoiceId: string };
    const isMemo = await step.run("peek", () =>
      withTenant(tenantId, async (tx) => {
        const [r] = await tx
          .select({ totalCents: supplierInvoice.totalCents })
          .from(supplierInvoice)
          .where(eq(supplierInvoice.id, supplierInvoiceId));
        return (r?.totalCents ?? 0) < 0;
      }),
    );
    if (isMemo) {
      return step.run("recover", () =>
        recoverCreditMemoHandler({ tenantId, supplierInvoiceId }, {
          loadInvoice: (t, id) =>
            withTenant(t, async (tx) => {
              const [r] = await tx
                .select({ supplierName: supplierInvoice.supplierName, totalCents: supplierInvoice.totalCents })
                .from(supplierInvoice)
                .where(eq(supplierInvoice.id, id));
              return { supplierName: r!.supplierName, totalCents: r!.totalCents };
            }),
          listOpen: (t, s) => listOpenSentCreditRequests(t, s),
          markCredited: (t, id, c) => markCreditRequestCredited(t, id, c),
          raiseReconcileCard: async () => {}, // Feed A is query-driven (Task 8)
        }),
      );
    }
    return step.run("guard", () =>
      priceGuardHandler({ tenantId, supplierInvoiceId }, {
        loadInvoice: (t, id) =>
          withTenant(t, async (tx) => {
            const [r] = await tx
              .select({
                jobId: supplierInvoice.jobId,
                supplierName: supplierInvoice.supplierName,
                invoiceNumber: supplierInvoice.invoiceNumber,
                parseConfidence: supplierInvoice.parseConfidence,
                totalCents: supplierInvoice.totalCents,
                lines: supplierInvoice.lines,
                senderEmail: supplierInvoice.senderEmail,
              })
              .from(supplierInvoice)
              .where(eq(supplierInvoice.id, id));
            if (!r) throw new Error(`supplier invoice ${id} not found`);
            return {
              jobId: r.jobId,
              supplierName: r.supplierName,
              invoiceNumber: r.invoiceNumber,
              parseConfidence: r.parseConfidence,
              totalCents: r.totalCents,
              lines: r.lines ?? [],
              senderEmail: r.senderEmail,
            };
          }),
        loadSnapshot: (t, jobId) => getMaterialOrderSnapshot(t, jobId),
        loadConfig: (t) =>
          withTenant(t, async (tx) => {
            const [row] = await tx
              .select({ settings: tenant.settings })
              .from(tenant)
              .where(eq(tenant.id, t));
            return parseFinanceConfig((row?.settings as { finance?: unknown } | undefined)?.finance).priceGuard;
          }),
        saveGuarded: (t, id, lines) => saveGuardedSupplierInvoice(t, id, lines),
        createCredit: (t, i) => createCreditRequest(t, i),
        sendEmail: async (opts) => {
          // No outbound email in e2e / test mode.
          if (process.env.TEST_MODE === "1") return { id: "test-email" };
          const emailSender = await getTenantEmail(tenantId, { gmailConnectionId: null });
          return emailSender.sendEmail({
            ...opts,
            from: process.env.EMAIL_FROM ?? "noreply@example.com",
          });
        },
        recordRun: (o) =>
          recordAgentRun({
            tenantId: o.tenantId,
            agent: "finance",
            taskKey: GUARD_TASK_KEY,
            jobId: o.jobId,
            status: o.status,
            error: o.error ?? null,
          }),
        gate: (t, jobId) =>
          gateAgentAutomation({ tenantId: t, jobId, taskKey: GUARD_TASK_KEY, agent: "finance" }),
        resolveRecipient: (senderEmail) => resolveSupplierRecipient(senderEmail, { selfDomains: SUPPLIER_SELF_DOMAINS }),
        loadAllowedDomains: (t) => listAllowedDomains(t),
        logAudit: (o) => console.log(JSON.stringify({ evt: "credit-request", ...o })),
        // Feed A (Today) is query-driven: Task 8 selects drafted credit_requests and
        // unmatched supplier invoices. No imperative insert is needed here.
        raiseDraftCard: async () => {},
      }),
    );
  },
);
