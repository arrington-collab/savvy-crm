"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EstimateLineItem } from "@savvy/core";
import { updateChangeOrderLineItemsAction, sendChangeOrderForSignatureAction, draftChangeOrderLineItemsAction } from "@/lib/change-order-actions";

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
        toast.success(r.summary ? `Drafted: ${r.summary}` : `Drafted ${r.lineItems.length} item(s) — review below.`);
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
      if ("ok" in r) toast.success("Sent for signature.");
      else if (r.error === "no_customer_email") toast.error("Add a customer email first.");
      else if (r.error === "no_template") toast.error("No change-order DocuSeal template configured.");
      else if (r.error === "docuseal_failed") toast.error("DocuSeal is not configured or unreachable.");
      else toast.error("Could not send.");
    });
  }

  return (
    <div data-testid="change-order-editor" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/jobs/${jobId}`} className="text-sm text-muted-foreground hover:underline">← Back to job</Link>
        <div className="flex items-center gap-3">
          <span className="text-xs rounded px-2 py-0.5 bg-muted">{changeOrder.status}</span>
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
        <Card>
          <CardHeader><CardTitle>Draft with AI</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <textarea
              value={aiDesc}
              onChange={(e) => setAiDesc(e.target.value)}
              placeholder="Describe the scope change in plain English (e.g. 'replace 3 pipe boots and add 2 squares of ridge cap')"
              aria-label="Describe the change"
              data-testid="ai-draft-input"
              className="w-full min-h-20 rounded border border-border bg-background p-2 text-sm"
            />
            <Button type="button" size="sm" variant="outline" disabled={draftPending} onClick={handleDraft} data-testid="ai-draft-btn">
              {draftPending ? "Drafting…" : "Draft with AI"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Line Items</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {lineItems.map((li, i) => (
            <div key={li.key} data-testid="change-order-line" className="grid grid-cols-[1fr_6rem_6rem_6rem_2.5rem] items-center gap-2">
              <span className="truncate text-sm">{li.name}</span>
              <Input type="number" min={0} step="any" value={li.quantity} onChange={(e) => updateQty(i, e.target.value)} className="h-8 text-sm" aria-label="Quantity" />
              <Input type="number" min={0} step="0.01" value={(li.unitPriceCents / 100).toFixed(2)} onChange={(e) => updateUnitPrice(i, e.target.value)} className="h-8 text-sm" aria-label="Unit price" />
              <span className="text-sm font-medium">{fmtUsd(li.amountCents)}</span>
              <button type="button" onClick={() => removeRow(i)} className="h-8 w-8 rounded text-muted-foreground hover:bg-destructive/10" aria-label="Remove row">×</button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addRow}>+ Add row</Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="ml-auto max-w-xs flex justify-between border-t border-border pt-1.5 text-base font-semibold">
            <span>Total</span>
            <span data-testid="change-order-total">{fmtUsd(totalCents)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
