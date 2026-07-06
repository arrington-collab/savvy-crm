import { withTenant, and, eq, lead, document, adminDb, tenant } from "@savvy/db";
import type { StorageGateway, EmailSender } from "@savvy/integrations";
import { r2Storage, getEmailSender } from "@savvy/integrations";
import type { CanvassContract } from "@savvy/core";
import { parseEmailConfig } from "@savvy/core";
import { inngest } from "../client";

/**
 * Stores a signed canvass contract as a tenant document: the full contract
 * (fields, scope items, signature data-URL, consent, hash) as a JSON blob in
 * R2 plus a `document` row (kind "contract") linked to the lead's customer.
 *
 * Pure helper (injectable storage) so it can be tested with a fake gateway
 * against a real DB. Idempotent: the r2Key is derived from the signing
 * integrity hash, and an existing document row with that key stores nothing.
 */
export async function storeCanvassContract(
  input: { tenantId: string; leadId: string; contract: CanvassContract },
  deps: { storage: StorageGateway },
): Promise<{ stored: boolean; reason?: string }> {
  const { tenantId, leadId, contract } = input;
  const dedupe = contract.integrityHash ?? `${leadId}-${Date.parse(contract.signedAt)}`;
  const r2Key = `${tenantId}/canvass/contract-${dedupe.toLowerCase()}.json`;

  const [l] = await withTenant(tenantId, (tx) =>
    tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, leadId)),
  );
  if (!l) return { stored: false, reason: "lead_not_found" };

  const dup = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: document.id })
      .from(document)
      .where(and(eq(document.tenantId, tenantId), eq(document.r2Key, r2Key))),
  );
  if (dup.length) return { stored: false, reason: "already_stored" };

  const bytes = new TextEncoder().encode(JSON.stringify(contract));
  await deps.storage.putObject({ key: r2Key, bytes, contentType: "application/json" });

  await withTenant(tenantId, (tx) =>
    tx.insert(document).values({
      tenantId,
      customerId: l.customerId,
      kind: "contract",
      label: contract.document,
      r2Key,
      filename: `${contract.kind}-contract-${contract.signedAt.slice(0, 10)}.json`,
      mime: "application/json",
      sizeBytes: bytes.byteLength,
      source: "savvy",
    }),
  );
  return { stored: true };
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Terms text → simple HTML: short ALL-CAPS lines become headings. */
function termsHtml(text: string): string {
  return text
    .split(/\n+/)
    .map((raw) => {
      const l = raw.trim();
      if (!l) return "";
      if (l.length < 64 && l === l.toUpperCase() && /[A-Z]{3}/.test(l)) return `<h4 style="letter-spacing:.5px;margin:16px 0 4px">${esc(l)}</h4>`;
      return `<p style="margin:0 0 10px">${esc(l)}</p>`;
    })
    .join("");
}

/**
 * Emails the homeowner their signed copy: agreement text, filled fields, scope
 * items, signer attestation, and the 72-hour rescission notice. The signature
 * image stays on file (data-URI images are blocked by most email clients).
 * Pure helper (injectable sender) for tests. Fail-soft by design — the caller
 * records the result; a missing email/config never fails the workflow.
 */
export async function emailSignedCopy(
  input: {
    contract: CanvassContract;
    customerEmail?: string | null;
    customerName?: string | null;
    companyName: string;
  },
  deps: { email: EmailSender; from?: string },
): Promise<{ sent: boolean; reason?: string }> {
  const { contract, customerEmail, customerName, companyName } = input;
  if (!customerEmail) return { sent: false, reason: "no_email" };
  const from = deps.from ?? process.env.EMAIL_FROM;
  if (!from) return { sent: false, reason: "no_from_address" };

  const fields = contract.fields ?? {};
  const fieldRows = Object.entries(fields)
    .map(([k, v]) => `<tr><td style="padding:5px 8px 5px 0;color:#555">${esc(k)}</td><td style="padding:5px 0;font-weight:600;text-align:right">${esc(v)}</td></tr>`)
    .join("");
  const scope = (contract.scopeItems ?? []).map(esc).join(" · ");
  const signedAt = new Date(contract.signedAt).toLocaleString("en-US");

  const html = `<div style="font-family:Georgia,serif;max-width:640px;margin:0 auto;color:#1f1e1b;line-height:1.6">
<h1 style="font-size:20px">${esc(companyName)} — ${esc(contract.document)}</h1>
<div style="background:#f0eee5;border-radius:10px;padding:12px 16px;font-size:14px">
Signed electronically by <b>${esc(customerName ?? "the property owner")}</b> on ${esc(signedAt)}.<br>
Representative: ${esc(contract.rep)}. Electronic-records consent: given.<br>
The signature image is retained on file${contract.integrityHash ? ` (record hash ${esc(contract.integrityHash.slice(0, 16))}…)` : ""}.
</div>
<div style="background:#fffbeb;border:1px solid #f0deb0;border-radius:10px;padding:12px 16px;font-size:14px;margin:14px 0">
<b>RIGHT TO CANCEL:</b> You may cancel this agreement within 72 hours of signing for a full deposit
refund (C.R.S. § 6-22-104). If your insurer denies your claim in whole or in part, an additional
72-hour rescission right applies upon written notice. To cancel, reply to this email or contact
${esc(companyName)} in writing.
</div>
${fieldRows ? `<table style="width:100%;border-collapse:collapse;font-size:14px">${fieldRows}</table>` : ""}
${scope ? `<p style="font-size:14px"><b>Scope items:</b> ${scope}</p>` : ""}
${contract.termsText ? termsHtml(contract.termsText) : `<p style="font-size:13px;color:#555">The full agreement text was presented and accepted at signing; reply to request another copy.</p>`}
<p style="font-size:12px;color:#8a857a">Keep this email for your records. Sent by ${esc(companyName)} via Savvy.</p>
</div>`;

  try {
    await deps.email.sendEmail({
      to: customerEmail,
      from,
      subject: `${companyName} — your signed ${contract.document}`,
      html,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `send_failed: ${String(e).slice(0, 200)}` };
  }
}

export const canvassContractSigned = inngest.createFunction(
  { id: "canvass-contract-signed" },
  { event: "canvass/contract.signed" },
  async ({ event, step }) => {
    const stored = await step.run("store-document", () =>
      storeCanvassContract(event.data, { storage: r2Storage }),
    );
    // Email only on first storage — a replayed event never double-sends.
    let emailed: { sent: boolean; reason?: string } = { sent: false, reason: "skipped" };
    if (stored.stored) {
      emailed = await step.run("email-homeowner-copy", async () => {
        const [t] = await adminDb
          .select({ name: tenant.name, settings: tenant.settings })
          .from(tenant)
          .where(eq(tenant.id, event.data.tenantId));
        const gmailConnectionId =
          parseEmailConfig((t?.settings as { email?: unknown } | undefined)?.email).gmailConnectionId ?? null;
        return emailSignedCopy(
          {
            contract: event.data.contract,
            customerEmail: event.data.customerEmail ?? event.data.contract.fields?.["Email"] ?? null,
            customerName: event.data.customerName ?? null,
            companyName: t?.name ?? "Your contractor",
          },
          { email: getEmailSender({ gmailConnectionId }) },
        );
      });
    }
    return { ...stored, emailed };
  },
);
