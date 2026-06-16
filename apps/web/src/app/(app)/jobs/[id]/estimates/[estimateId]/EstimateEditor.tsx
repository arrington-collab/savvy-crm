"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EstimateLineItem } from "@savvy/core";
import {
  updateEstimateLineItemsAction,
  acceptUpsellAction,
  sendEstimateAction,
} from "@/lib/estimate-actions";

// Shape returned by getEstimate — mirrors the DB schema.
interface EstimateRow {
  id: string;
  jobId: string;
  source: string;
  status: string;
  lineItems: unknown[];
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  measurementId: string | null;
  upsellSuggestions: unknown[];
  sentAt: Date | null;
  acceptedAt: Date | null;
  docusealSubmissionId: string | null;
}

interface UpsellSuggestion {
  name: string;
  reason?: string;
  unitPriceCents: number;
  quantity: number;
}

interface EstimateEditorProps {
  estimate: EstimateRow;
  jobId: string;
}

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-800",
  accepted: "bg-green-100 text-green-800",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {status}
    </span>
  );
}

export function EstimateEditor({ estimate, jobId }: EstimateEditorProps) {
  // Cast jsonb arrays to typed shapes.
  const [lineItems, setLineItems] = useState<EstimateLineItem[]>(
    (estimate.lineItems as EstimateLineItem[]) ?? [],
  );
  const [upsells, setUpsells] = useState<UpsellSuggestion[]>(
    (estimate.upsellSuggestions as UpsellSuggestion[]) ?? [],
  );

  // Totals computed from current lineItems (updated optimistically on edit).
  const subtotalCents = lineItems.reduce((s, li) => s + li.amountCents, 0);
  // Keep tax ratio from server if available; else 0.
  const taxRatio =
    estimate.subtotal && estimate.tax
      ? estimate.tax / estimate.subtotal
      : 0;
  const taxCents = Math.round(subtotalCents * taxRatio);
  const totalCents = subtotalCents + taxCents;

  const [savePending, startSave] = useTransition();
  const [sendPending, startSend] = useTransition();
  const [upsellPending, startUpsell] = useTransition();

  function updateQty(index: number, rawValue: string) {
    const qty = parseFloat(rawValue) || 0;
    setLineItems((prev) =>
      prev.map((li, i) =>
        i === index
          ? {
              ...li,
              quantity: qty,
              amountCents: Math.round(qty * li.unitPriceCents),
            }
          : li,
      ),
    );
  }

  function updateUnitPrice(index: number, rawValue: string) {
    // UI shows dollars; store cents.
    const dollars = parseFloat(rawValue) || 0;
    const unitPriceCents = Math.round(dollars * 100);
    setLineItems((prev) =>
      prev.map((li, i) =>
        i === index
          ? {
              ...li,
              unitPriceCents,
              amountCents: Math.round(li.quantity * unitPriceCents),
            }
          : li,
      ),
    );
  }

  function addRow() {
    setLineItems((prev) => [
      ...prev,
      {
        key: `manual-${Date.now()}`,
        name: "New item",
        category: "other" as EstimateLineItem["category"],
        unit: "each" as EstimateLineItem["unit"],
        quantity: 1,
        unitPriceCents: 0,
        amountCents: 0,
      },
    ]);
  }

  function removeRow(index: number) {
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  }

  function handleSave() {
    startSave(async () => {
      await updateEstimateLineItemsAction({
        estimateId: estimate.id,
        jobId,
        lineItems,
      });
    });
  }

  function handleAcceptUpsell(index: number) {
    startUpsell(async () => {
      await acceptUpsellAction({ estimateId: estimate.id, jobId, index });
      // Optimistically remove from local upsells list.
      setUpsells((prev) => prev.filter((_, i) => i !== index));
    });
  }

  function handleSend() {
    startSend(async () => {
      await sendEstimateAction(estimate.id, jobId);
    });
  }

  return (
    <div data-testid="estimate-editor" className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/jobs/${jobId}`}
              className="text-sm text-muted-foreground hover:underline"
            >
              ← Back to job
            </Link>
          </div>
          <h1 className="text-xl font-semibold capitalize">
            {estimate.source} Estimate
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={estimate.status} />
          <Button
            size="sm"
            variant="outline"
            disabled={savePending}
            onClick={handleSave}
          >
            {savePending ? "Saving…" : "Save"}
          </Button>
          <Button
            size="sm"
            disabled={sendPending || estimate.status === "accepted"}
            onClick={handleSend}
            data-testid="send-estimate-btn"
          >
            {sendPending ? "Sending…" : "Send for signature"}
          </Button>
        </div>
      </div>

      {estimate.docusealSubmissionId && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          Sent for signature · submission ID: {estimate.docusealSubmissionId}
        </div>
      )}

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle>Line Items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_6rem_6rem_6rem_2.5rem] gap-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <span>Item</span>
            <span>Qty</span>
            <span>Unit price</span>
            <span>Amount</span>
            <span />
          </div>

          {lineItems.map((li, index) => (
            <div
              key={li.key}
              data-testid="estimate-line"
              className="grid grid-cols-[1fr_6rem_6rem_6rem_2.5rem] items-center gap-2"
            >
              <span className="truncate text-sm">{li.name}</span>
              <Input
                type="number"
                min={0}
                step="any"
                value={li.quantity}
                onChange={(e) => updateQty(index, e.target.value)}
                className="h-8 text-sm"
                aria-label="Quantity"
              />
              <Input
                type="number"
                min={0}
                step="0.01"
                value={(li.unitPriceCents / 100).toFixed(2)}
                onChange={(e) => updateUnitPrice(index, e.target.value)}
                className="h-8 text-sm"
                aria-label="Unit price"
              />
              <span className="text-sm font-medium">
                {fmtUsd(li.amountCents)}
              </span>
              <button
                type="button"
                onClick={() => removeRow(index)}
                className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                aria-label="Remove row"
              >
                ×
              </button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
          >
            + Add row
          </Button>
        </CardContent>
      </Card>

      {/* Upsell suggestions */}
      {upsells.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>AI Upsell Suggestions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {upsells.map((u, index) => (
              <div
                key={index}
                className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2"
              >
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">{u.name}</div>
                  {u.reason && (
                    <div className="text-xs text-muted-foreground">{u.reason}</div>
                  )}
                  <div className="text-xs">
                    {fmtUsd(u.unitPriceCents)} × {u.quantity}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={upsellPending}
                  onClick={() => handleAcceptUpsell(index)}
                >
                  Add
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Totals */}
      <Card>
        <CardContent className="pt-4">
          <div className="ml-auto max-w-xs space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{fmtUsd(subtotalCents)}</span>
            </div>
            {taxCents > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Tax</span>
                <span>{fmtUsd(taxCents)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold">
              <span>Total</span>
              <span data-testid="estimate-total">{fmtUsd(totalCents)}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
