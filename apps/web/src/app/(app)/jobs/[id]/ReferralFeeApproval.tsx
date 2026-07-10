"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveReferralPaymentAction } from "@/lib/referral-actions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtUsd } from "@/lib/format";

/** Minimal one-tap approval card for an over-threshold referral fee. Modeled on the
 * depreciation approval surfaced in ClaimPanel. */
export function ReferralFeeApproval({ jobId, title, amountCents }: { jobId: string; title: string; amountCents: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hint, setHint] = useState<string | null>(null);

  function handleApprove() {
    start(async () => {
      const r = await approveReferralPaymentAction({ jobId });
      if ("ok" in r) { setHint(null); router.refresh(); }
      else { setHint(r.error); }
    });
  }

  return (
    <Card data-testid="referral-fee-approval" className="p-5">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-0">
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="mono text-xs text-muted-foreground">{fmtUsd(amountCents)}</div>
        </div>
        <div className="flex items-center gap-2">
          {hint && <span className="text-xs text-destructive">{hint}</span>}
          <Button data-testid="referral-fee-approve" size="sm" disabled={pending} onClick={handleApprove}>
            {pending ? "Approving…" : "Approve"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
