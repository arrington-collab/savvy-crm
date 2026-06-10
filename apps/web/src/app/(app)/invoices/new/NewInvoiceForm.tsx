"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createInvoiceAction, createFromEstimateAction } from "@/lib/finance-actions";
import type { LineItem } from "@savvy/core";

type LineItemRow = {
  description: string;
  qty: string;
  unitAmountDollars: string;
};

function emptyRow(): LineItemRow {
  return { description: "", qty: "1", unitAmountDollars: "" };
}

export function NewInvoiceForm({ defaultJobId }: { defaultJobId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [jobId, setJobId] = useState(defaultJobId);
  const [rows, setRows] = useState<LineItemRow[]>([emptyRow()]);

  // For "create from estimate" section
  const [estimateId, setEstimateId] = useState("");
  const [estimatePending, startEstimate] = useTransition();

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function updateRow(index: number, field: keyof LineItemRow, value: string) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const lineItems: LineItem[] = rows
      .filter((r) => r.description.trim() !== "")
      .map((r) => ({
        description: r.description.trim(),
        qty: Number(r.qty) || 1,
        unitAmountCents: Math.round((parseFloat(r.unitAmountDollars) || 0) * 100),
      }));

    if (lineItems.length === 0) {
      toast.error("Add at least one line item.");
      return;
    }

    start(async () => {
      const result = await createInvoiceAction(jobId.trim(), lineItems);
      if (result.ok) {
        toast.success("Invoice created");
        router.push(`/invoices/${result.id}`);
      }
    });
  }

  function handleFromEstimate() {
    if (!estimateId.trim()) {
      toast.error("Enter an estimate ID.");
      return;
    }
    startEstimate(async () => {
      const result = await createFromEstimateAction(estimateId.trim());
      if (result.ok) {
        toast.success("Invoice created from estimate");
        router.push(`/invoices/${result.id}`);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Main create form */}
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="jobId">Job ID</Label>
          <Input
            id="jobId"
            type="text"
            placeholder="Optional — paste a job ID"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Line Items</Label>
            <Button type="button" size="sm" variant="outline" onClick={addRow} disabled={pending}>
              + Add Row
            </Button>
          </div>

          <div className="space-y-2">
            {rows.map((row, i) => (
              <Card key={i} className="p-3">
                <div className="grid grid-cols-[1fr_80px_120px_auto] gap-2 items-end">
                  <div className="space-y-1">
                    <Label className="text-xs">Description</Label>
                    <Input
                      type="text"
                      placeholder="e.g. Roof replacement"
                      value={row.description}
                      onChange={(e) => updateRow(i, "description", e.target.value)}
                      disabled={pending}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Qty</Label>
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      value={row.qty}
                      onChange={(e) => updateRow(i, "qty", e.target.value)}
                      disabled={pending}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Unit ($)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={row.unitAmountDollars}
                      onChange={(e) => updateRow(i, "unitAmountDollars", e.target.value)}
                      disabled={pending}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending || rows.length <= 1}
                    onClick={() => removeRow(i)}
                    className="text-destructive hover:text-destructive"
                  >
                    Remove
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>

        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create Invoice"}
        </Button>
      </form>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 border-t" />
        <span className="text-xs text-muted-foreground">or</span>
        <div className="flex-1 border-t" />
      </div>

      {/* Create from estimate */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Create from Estimate</p>
        <div className="flex gap-2">
          <Input
            type="text"
            placeholder="Estimate ID"
            value={estimateId}
            onChange={(e) => setEstimateId(e.target.value)}
            disabled={estimatePending}
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleFromEstimate}
            disabled={estimatePending}
          >
            {estimatePending ? "Creating…" : "Use Estimate"}
          </Button>
        </div>
      </div>
    </div>
  );
}
