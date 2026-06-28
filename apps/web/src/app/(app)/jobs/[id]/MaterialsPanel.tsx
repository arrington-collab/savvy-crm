"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { fmtUsd } from "@/lib/format";
import { generateMaterialOrderAction, advanceMaterialOrderStatusAction } from "@/lib/material-actions";

export type MaterialsPanelLine = { key: string; name: string; quantity: number; unit: string; amountCents: number };
export type MaterialsPanelOrder = {
  id: string;
  status: string;
  subtotalCents: number;
  neededByISO: string | null;
  lines: MaterialsPanelLine[];
  flag: "none" | "no_install" | "misaligned";
};

const FLAG_COPY: Record<MaterialsPanelOrder["flag"], string | null> = {
  none: null,
  no_install: "No install scheduled — set a crew date to align delivery.",
  misaligned: "⚠ Delivery target is after the install date.",
};

const NEXT_STATUS: Record<string, "ordered" | "delivered" | null> = {
  draft: "ordered",
  ordered: "delivered",
  delivered: null,
  canceled: null,
};

export function MaterialsPanel({ jobId, orders }: { jobId: string; orders: MaterialsPanelOrder[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [generateError, setGenerateError] = useState<string | null>(null);

  function handleGenerate() {
    start(async () => {
      const r = await generateMaterialOrderAction({ jobId });
      if ("error" in r) {
        if (r.error === "no_accepted_estimate") {
          setGenerateError("Accept an estimate first to generate a material order.");
        } else {
          setGenerateError("Failed to generate material order. Please try again.");
        }
      } else {
        setGenerateError(null);
        router.refresh();
      }
    });
  }
  function handleAdvance(materialOrderId: string, status: "ordered" | "delivered") {
    start(async () => {
      await advanceMaterialOrderStatusAction({ materialOrderId, jobId, status });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4" data-testid="materials-panel">
      <Button size="sm" variant="outline" disabled={pending} onClick={handleGenerate} data-testid="generate-material-order-btn">
        {pending ? "Working…" : "Generate from estimate"}
      </Button>
      {generateError && (
        <p className="text-xs" data-testid="material-generate-error" style={{ color: "var(--text-faint)" }}>
          {generateError}
        </p>
      )}

      {orders.length === 0 && (
        <p className="text-sm" style={{ color: "var(--text-faint)" }}>
          No material order yet. Generate one from the accepted estimate.
        </p>
      )}

      {orders.map((o) => {
        const next = NEXT_STATUS[o.status] ?? null;
        const flagCopy = FLAG_COPY[o.flag];
        return (
          <div key={o.id} className="rounded-md border border-border p-3 space-y-2" data-testid="material-order">
            <div className="flex items-center justify-between">
              <StatusBadge status={o.status} />
              <span className="mono font-medium text-accent-gold" data-testid="material-order-subtotal">{fmtUsd(o.subtotalCents)}</span>
            </div>
            <ul className="space-y-1 text-sm">
              {o.lines.map((l) => (
                <li key={l.key} className="flex items-center justify-between" data-testid="material-order-line">
                  <span style={{ color: "var(--text-muted)" }}>{l.name} · {l.quantity} {l.unit}</span>
                  <span className="mono">{fmtUsd(l.amountCents)}</span>
                </li>
              ))}
            </ul>
            {flagCopy && (
              <p className="text-xs" data-testid="material-order-flag" style={{ color: "var(--text-faint)" }}>{flagCopy}</p>
            )}
            {next && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => handleAdvance(o.id, next)} data-testid="advance-material-order-btn">
                {next === "ordered" ? "Mark ordered" : "Mark delivered"}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
