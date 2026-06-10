"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  sendInvoiceAction,
  voidInvoiceAction,
  createCheckoutForInvoice,
} from "@/lib/finance-actions";

type LineItem = {
  description: string;
  qty: number;
  unitAmountCents: number;
};

type PaymentRow = {
  id: string;
  method: string | null;
  amount: number;
  receivedAt: string | null;
  stripePaymentId: string | null;
};

type InvoiceProps = {
  invoice: {
    id: string;
    number: string | null;
    status: string | null;
    amountDue: number | null;
    amountPaid: number;
    dueAt: string | null;
    lineItems: unknown[];
  };
  payments: PaymentRow[];
};

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  void: "bg-red-100 text-red-800",
  partial: "bg-yellow-100 text-yellow-800",
};

function StatusBadge({ status }: { status: string | null }) {
  const label = status ?? "unknown";
  const cls = STATUS_COLORS[label] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

export function InvoiceDetail({ invoice: inv, payments }: InvoiceProps) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const lineItems = inv.lineItems.map((item) => item as LineItem);

  function handleSend() {
    start(async () => {
      const result = await sendInvoiceAction(inv.id);
      if ("error" in result && result.error === "stripe_not_connected") {
        toast.error("Connect Stripe in Settings → Payments first.");
        return;
      }
      toast.success("Invoice sent");
      router.refresh();
    });
  }

  function handleVoid() {
    start(async () => {
      await voidInvoiceAction(inv.id);
      toast.success("Invoice voided");
      router.refresh();
    });
  }

  function handlePayLink() {
    start(async () => {
      const result = await createCheckoutForInvoice(inv.id);
      if ("error" in result) {
        if (result.error === "stripe_not_connected") {
          toast.error("Connect Stripe in Settings → Payments first.");
        } else {
          toast.error(`Error: ${result.error}`);
        }
        return;
      }
      if ("url" in result) {
        window.open(result.url, "_blank");
      }
    });
  }

  const isDraft = inv.status === "draft";
  const isSent = inv.status === "sent";
  const canVoid = isDraft || isSent;

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{inv.number ?? "Draft Invoice"}</h1>
          {inv.dueAt && (
            <p className="text-sm text-muted-foreground">
              Due {new Date(inv.dueAt).toLocaleDateString()}
            </p>
          )}
        </div>
        <StatusBadge status={inv.status} />
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        {isDraft && (
          <Button size="sm" onClick={handleSend} disabled={pending}>
            Send Invoice
          </Button>
        )}
        {isSent && (
          <Button size="sm" variant="outline" onClick={handlePayLink} disabled={pending}>
            Get Pay Link
          </Button>
        )}
        {canVoid && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleVoid}
            disabled={pending}
            className="text-destructive hover:text-destructive"
          >
            Void
          </Button>
        )}
      </div>

      {/* Line items */}
      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-semibold">Line Items</h2>
        {lineItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">No line items.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="pb-2 font-medium">Description</th>
                <th className="pb-2 font-medium text-right">Qty</th>
                <th className="pb-2 font-medium text-right">Unit</th>
                <th className="pb-2 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-2">{item.description}</td>
                  <td className="py-2 text-right">{item.qty}</td>
                  <td className="py-2 text-right">{fmtUsd(item.unitAmountCents)}</td>
                  <td className="py-2 text-right font-medium">
                    {fmtUsd(item.qty * item.unitAmountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Totals */}
        <div className="flex flex-col items-end gap-1 pt-2 border-t text-sm">
          <div className="flex gap-6">
            <span className="text-muted-foreground">Amount Due</span>
            <span className="font-semibold">
              {inv.amountDue !== null ? fmtUsd(inv.amountDue) : "—"}
            </span>
          </div>
          <div className="flex gap-6">
            <span className="text-muted-foreground">Amount Paid</span>
            <span className="font-medium">{fmtUsd(inv.amountPaid)}</span>
          </div>
        </div>
      </Card>

      {/* Payments */}
      {payments.length > 0 && (
        <Card className="p-4 space-y-3">
          <h2 className="text-sm font-semibold">Payments</h2>
          <div className="space-y-2">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm">
                <div className="space-y-0.5">
                  <div className="font-medium">{fmtUsd(p.amount)}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.method ?? "—"}
                    {p.receivedAt
                      ? ` · ${new Date(p.receivedAt).toLocaleDateString()}`
                      : ""}
                    {p.stripePaymentId ? ` · ${p.stripePaymentId}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
