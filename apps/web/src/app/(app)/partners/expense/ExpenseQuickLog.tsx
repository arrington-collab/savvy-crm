"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PartnerPicker, type PartnerSelection } from "@/components/PartnerPicker";
import { logPartnerExpenseAction } from "@/lib/partner-actions";

export function ExpenseQuickLog() {
  const [pending, start] = useTransition();
  const [partnerSel, setPartnerSel] = useState<PartnerSelection | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(amount) * 100);
    if (!partnerSel) { toast.error("Pick a partner"); return; }
    if (!Number.isFinite(cents) || cents <= 0) { toast.error("Enter an amount"); return; }
    start(async () => {
      const res = await logPartnerExpenseAction({
        partnerId: partnerSel.kind === "existing" ? partnerSel.id : undefined,
        partner: partnerSel.kind === "new" ? { name: partnerSel.name, org: partnerSel.org } : undefined,
        amountCents: cents,
        note,
      });
      if ("error" in res) { toast.error(res.error); return; }
      toast.success("Expense logged");
      setPartnerSel(null);
      setAmount("");
      setNote("");
    });
  }

  return (
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-4" data-testid="partner-expense-form">
        <div className="space-y-1.5">
          <Label>Partner</Label>
          <PartnerPicker value={partnerSel} onChange={setPartnerSel} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="expense-amount">Amount ($)</Label>
          <Input id="expense-amount" data-testid="expense-amount" type="number" inputMode="decimal"
                 min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="45.00" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="expense-note">Note</Label>
          <Input id="expense-note" data-testid="expense-note" value={note}
                 onChange={(e) => setNote(e.target.value)} placeholder="Lunch — Q3 check-in" />
        </div>
        <Button type="submit" disabled={pending} data-testid="expense-submit" className="w-full">
          {pending ? "Logging…" : "Log expense"}
        </Button>
      </form>
    </Card>
  );
}
