"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EstimateLineItem } from "@savvy/core";
import { updateChangeOrderLineItemsAction, sendChangeOrderForSignatureAction, draftChangeOrderLineItemsAction } from "@/lib/change-order-actions";
import { agentToast } from "@/components/cockpit/agentToast";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { PERSONAS } from "@/lib/agents";

interface ChangeOrderRow {
  id: string; jobId: string; reason: string | null; status: string;
  lineItems: unknown[]; total: number | null; signingUrl: string | null; docusealSubmissionId: string | null;
}

function fmtUsd(c: number): string { return (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }); }

export function ChangeOrderEditor({ changeOrder, jobId }: { changeOrder: ChangeOrderRow; jobId: string }) {
  const [lineItems, setLineItems] = useState<EstimateLineItem[]>((changeOrder.lineItems as EstimateLineItem[]) ?? []);
  const [reason, setReason] = useState(changeOrder.reason ?? "");
  const [savePending, startSave] = useTransition();
  const [sendPending, startSend] = useTransition();
  const [aiDesc, setAiDesc] = useState("");
  const [draftPending, startDraft] = useTransition();
  const totalCents = lineItems.reduce((s, li) => s + li.amountCents, 0);

  function updateQty(i: number, v: string) {
    const qty = parseFloat(v) || 0;
    setLineItems((p) => p.map((li, idx) => idx === i ? { ...li, quantity: qty, amountCents: Math.round(qty * li.unitPriceCents) } : li));
  }
  function updateUnitPrice(i: number, v: string) {
    const cents = Math.round((parseFloat(v) || 0) * 100);
    setLineItems((p) => p.map((li, idx) => idx === i ? { ...li, unitPriceCents: cents, amountCents: Math.round(li.quantity * cents) } : li));
  }
  function addRow() {
    setLineItems((p) => [...p, { key: `manual-${Date.now()}`, name: "New item", category: "other" as EstimateLineItem["category"], unit: "each" as EstimateLineItem["unit"], quantity: 1, unitPriceCents: 0, amountCents: 0 }]);
  }
  function removeRow(i: number) { setLineItems((p) => p.filter((_, idx) => idx !== i)); }
  function handleDraft() {
    startDraft(async () => {
      const r = await draftChangeOrderLineItemsAction({ jobId, description: aiDesc });
      if ("ok" in r) {
        setLineItems((p) => [...p, ...r.lineItems]);
        agentToast("VERA", r.summary ? `Drafted: ${r.summary}` : `Drafted ${r.lineItems.length} line${r.lineItems.length === 1 ? "" : "s"} from the inspection — every line measured.`);
        setAiDesc("");
      } else if (r.error === "empty_description") {
        toast.error("Describe the change first.");
      } else {
        toast.error("AI drafting is unavailable right now.");
      }
    });
  }
  function handleSave() { startSave(async () => { await updateChangeOrderLineItemsAction({ changeOrderId: changeOrder.id, jobId, lineItems }); }); }
  function handleSend() {
    startSend(async () => {
      const r = await sendChangeOrderForSignatureAction(changeOrder.id, jobId);
      if ("ok" in r) agentToast("RAINE", "Sent for signature — I'll watch for the sign-off.");
      else if (r.error === "no_customer_email") toast.error("Add a customer email first.");
      else if (r.error === "no_template") toast.error("No change-order DocuSeal template configured.");
      else if (r.error === "docuseal_failed") toast.error("DocuSeal is not configured or unreachable.");
      else toast.error("Could not send.");
    });
  }

  return (
    <div data-testid="change-order-editor" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/jobs/${jobId}`} className="mono text-sm" style={{ color: "var(--text-muted)" }}>← Back to job</Link>
        <div className="flex items-center gap-3">
          <span className="mono rounded px-2 py-0.5 text-[11px] uppercase tracking-wider" style={{ background: "var(--accent-006)", border: "1px solid var(--border-panel)", color: "var(--text-muted)" }}>{changeOrder.status}</span>
          <Button size="sm" variant="outline" disabled={savePending} onClick={handleSave}>{savePending ? "Saving…" : "Save"}</Button>
          <Button size="sm" disabled={sendPending || changeOrder.status !== "draft"} onClick={handleSend} data-testid="send-change-order-btn">
            {sendPending ? "Sending…" : "Send for signature"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Reason</CardTitle></CardHeader>
        <CardContent>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is the scope changing?" aria-label="Reason" />
        </CardContent>
      </Card>

      {changeOrder.status === "draft" && (
        <Card style={draftPending ? { boxShadow: "var(--glow-accent)", borderColor: "var(--accent-040)" } : undefined}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AgentAvatar persona={PERSONAS.VERA} size="sm" />
              <span className="text-accent-gold">✦</span> Draft with VERA
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <textarea
              value={aiDesc}
              onChange={(e) => setAiDesc(e.target.value)}
              placeholder="Describe the scope change in plain English (e.g. 'replace 3 pipe boots and add 2 squares of ridge cap')"
              aria-label="Describe the change"
              data-testid="ai-draft-input"
              className="min-h-20 w-full rounded-md p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              style={{ background: "var(--surface-panel)", border: "1px solid var(--border-panel)", color: "var(--text-primary)" }}
            />
            <Button type="button" size="sm" variant="outline" disabled={draftPending} onClick={handleDraft} data-testid="ai-draft-btn"
              className="border-[var(--accent-040)] text-accent-gold hover:bg-[var(--accent-010)]">
              {draftPending ? "Drafting…" : "✦ Draft with VERA"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Line Items</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          <div className="mono grid grid-cols-[1fr_6rem_6rem_6rem_2.5rem] gap-2 px-1 pb-1 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-faint)", borderBottom: "1px solid var(--border-panel)" }}>
            <span>Item</span><span className="text-right">Qty</span><span className="text-right">Unit</span><span className="text-right">Amount</span><span />
          </div>
          {lineItems.map((li, i) => (
            <div key={li.key} data-testid="change-order-line" className="grid grid-cols-[1fr_6rem_6rem_6rem_2.5rem] items-center gap-2 rounded px-1 py-1" style={{ background: i % 2 ? "var(--surface-panel)" : "transparent" }}>
              <span className="truncate text-sm" style={{ color: "var(--text-body)" }}>{li.name}</span>
              <Input type="number" min={0} step="any" value={li.quantity} onChange={(e) => updateQty(i, e.target.value)} className="mono h-8 text-right text-sm" aria-label="Quantity" />
              <Input type="number" min={0} step="0.01" value={(li.unitPriceCents / 100).toFixed(2)} onChange={(e) => updateUnitPrice(i, e.target.value)} className="mono h-8 text-right text-sm" aria-label="Unit price" />
              <span className="mono text-right text-sm font-medium" style={{ color: "var(--text-primary)" }}>{fmtUsd(li.amountCents)}</span>
              <button type="button" onClick={() => removeRow(i)} className="h-8 w-8 rounded hover:bg-[var(--accent-006)]" style={{ color: "var(--text-muted)" }} aria-label="Remove row">×</button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addRow} className="mt-2">+ Add row</Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="ml-auto flex max-w-xs items-center justify-between pt-1.5 text-base font-semibold" style={{ borderTop: "1px solid var(--accent-030)" }}>
            <span className="eyebrow" style={{ fontSize: "0.75rem" }}>Total</span>
            <span className="mono text-lg text-accent-gold" data-testid="change-order-total">{fmtUsd(totalCents)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
