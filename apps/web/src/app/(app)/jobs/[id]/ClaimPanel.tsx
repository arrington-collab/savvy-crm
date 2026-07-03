"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { fmtUsd } from "@/lib/format";
import { CLAIM_STATUS } from "@savvy/core";
import type { ClaimStatus } from "@savvy/core";
import { saveClaimAction, bookAdjusterMeetingAction, uploadXactimatePricingAction, sendDepreciationInvoiceAction } from "@/lib/claim-actions";

export type ClaimPanelTask = { id: string; title: string; status: string };
export type ClaimDepreciation = {
  recoverableCents: number;
  draftInvoiceId: string | null;
  draftStatus: "none" | "pending_approval" | "sent";
};

function centsToDollars(cents: number | null): string {
  if (cents == null) return "";
  return (cents / 100).toString();
}

export function ClaimPanel({
  jobId,
  claim,
  adjusterAppointment,
  tasks,
  depreciation,
}: {
  jobId: string;
  claim: {
    claimNumber: string | null;
    carrierName: string | null;
    adjusterName: string | null;
    adjusterPhone: string | null;
    status: ClaimStatus;
    acvCents: number | null;
    rcvCents: number | null;
    deductibleCents: number | null;
    filedAtISO: string | null;
  } | null;
  adjusterAppointment: { startsAtISO: string; endsAtISO: string } | null;
  tasks: ClaimPanelTask[];
  depreciation?: ClaimDepreciation | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  // Claim form state
  const [claimNumber, setClaimNumber] = useState(claim?.claimNumber ?? "");
  const [carrierName, setCarrierName] = useState(claim?.carrierName ?? "");
  const [adjusterName, setAdjusterName] = useState(claim?.adjusterName ?? "");
  const [adjusterPhone, setAdjusterPhone] = useState(claim?.adjusterPhone ?? "");
  const [status, setStatus] = useState<ClaimStatus>(claim?.status ?? "filed");
  const [acvDollars, setAcvDollars] = useState(centsToDollars(claim?.acvCents ?? null));
  const [rcvDollars, setRcvDollars] = useState(centsToDollars(claim?.rcvCents ?? null));
  const [deductibleDollars, setDeductibleDollars] = useState(centsToDollars(claim?.deductibleCents ?? null));
  const [filedAt, setFiledAt] = useState(claim?.filedAtISO?.slice(0, 10) ?? "");
  const [saveHint, setSaveHint] = useState<"saved" | "error" | null>(null);

  // Adjuster meeting booking state
  const [adjusterTime, setAdjusterTime] = useState("");
  const [bookHint, setBookHint] = useState<"slot_taken" | "invalid_time" | null>(null);

  // Depreciation-recovery state (§G)
  const [updatedRcvDollars, setUpdatedRcvDollars] = useState("");
  const [depHint, setDepHint] = useState<string | null>(null);

  function handleSave() {
    start(async () => {
      try {
        await saveClaimAction({
          jobId,
          claimNumber,
          carrierName,
          adjusterName,
          adjusterPhone,
          status,
          acvDollars,
          rcvDollars,
          deductibleDollars,
          filedAt,
        });
        setSaveHint("saved");
        router.refresh();
      } catch {
        setSaveHint("error");
      }
    });
  }

  function handleBook() {
    if (!adjusterTime) return;
    start(async () => {
      const r = await bookAdjusterMeetingAction({
        jobId,
        startsAtISO: new Date(adjusterTime).toISOString(),
      });
      if ("ok" in r) {
        setBookHint(null);
        setAdjusterTime("");
        router.refresh();
      } else {
        setBookHint(r.error);
      }
    });
  }

  function handleGenerateRecovery() {
    start(async () => {
      const r = await uploadXactimatePricingAction({ jobId, updatedRcvDollars });
      if ("ok" in r) { setDepHint(null); setUpdatedRcvDollars(""); router.refresh(); }
      else { setDepHint(r.error); }
    });
  }

  function handleSendRecovery(invoiceId: string) {
    start(async () => {
      const r = await sendDepreciationInvoiceAction({ jobId, invoiceId });
      if ("ok" in r) { setDepHint(null); router.refresh(); }
      else { setDepHint(r.error); }
    });
  }

  return (
    <div className="space-y-5" data-testid="claim-panel">
      {/* Claim fields */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Claim #</label>
          <input
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
            value={claimNumber}
            onChange={(e) => setClaimNumber(e.target.value)}
            placeholder="e.g. 2024-001234"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Carrier</label>
          <input
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
            value={carrierName}
            onChange={(e) => setCarrierName(e.target.value)}
            placeholder="Insurance carrier name"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Adjuster name</label>
          <input
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
            value={adjusterName}
            onChange={(e) => setAdjusterName(e.target.value)}
            placeholder="Full name"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Adjuster phone</label>
          <input
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
            value={adjusterPhone}
            onChange={(e) => setAdjusterPhone(e.target.value)}
            placeholder="+1 555 000 0000"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Status</label>
          <select
            data-testid="claim-status-select"
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
            value={status}
            onChange={(e) => setStatus(e.target.value as ClaimStatus)}
          >
            {CLAIM_STATUS.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Filed date</label>
          <input
            type="date"
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
            value={filedAt}
            onChange={(e) => setFiledAt(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>ACV ($)</label>
          <input
            type="number"
            step="0.01"
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
            value={acvDollars}
            onChange={(e) => setAcvDollars(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>RCV ($)</label>
          <input
            type="number"
            step="0.01"
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
            value={rcvDollars}
            onChange={(e) => setRcvDollars(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Deductible ($)</label>
          <input
            type="number"
            step="0.01"
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
            value={deductibleDollars}
            onChange={(e) => setDeductibleDollars(e.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={handleSave}
          data-testid="save-claim-btn"
        >
          {pending ? "Saving…" : "Save claim"}
        </Button>
        {saveHint === "saved" && (
          <span className="text-xs" style={{ color: "var(--text-faint)" }}>Saved.</span>
        )}
        {saveHint === "error" && (
          <span className="text-xs text-destructive">Failed to save. Please try again.</span>
        )}
      </div>

      {/* Adjuster meeting */}
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Adjuster meeting</p>
        {adjusterAppointment && (
          <p className="text-sm" data-testid="adjuster-appt" style={{ color: "var(--text-muted)" }}>
            Scheduled: {new Date(adjusterAppointment.startsAtISO).toLocaleString()}
            {" "}–{" "}
            {new Date(adjusterAppointment.endsAtISO).toLocaleString()}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            className="rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
            value={adjusterTime}
            onChange={(e) => { setAdjusterTime(e.target.value); setBookHint(null); }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!adjusterTime || pending}
            onClick={handleBook}
            data-testid="book-adjuster-btn"
          >
            {pending ? "Booking…" : "Book adjuster meeting"}
          </Button>
        </div>
        {bookHint === "slot_taken" && (
          <p className="text-xs text-destructive">That time conflicts with another appointment.</p>
        )}
        {bookHint === "invalid_time" && (
          <p className="text-xs text-destructive">Pick a valid time.</p>
        )}
      </div>

      {/* Claim tasks read-only */}
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Claim tasks</p>
        {tasks.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No claim tasks.</p>
        ) : (
          <ul className="space-y-1">
            {tasks.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                data-testid="claim-task-row"
              >
                <span style={{ color: "var(--text-muted)" }}>{t.title}</span>
                <StatusBadge status={t.status} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ACV/RCV summary if values are set */}
      {(claim?.acvCents != null || claim?.rcvCents != null) && (
        <div className="flex flex-wrap items-center gap-6 rounded-md border border-border p-3 text-sm">
          {claim?.acvCents != null && (
            <div>
              <span className="text-xs" style={{ color: "var(--text-faint)" }}>ACV</span>
              <div className="mono font-medium text-accent-gold">{fmtUsd(claim.acvCents)}</div>
            </div>
          )}
          {claim?.rcvCents != null && (
            <div>
              <span className="text-xs" style={{ color: "var(--text-faint)" }}>RCV</span>
              <div className="mono font-medium text-accent-gold">{fmtUsd(claim.rcvCents)}</div>
            </div>
          )}
          {claim?.deductibleCents != null && (
            <div>
              <span className="text-xs" style={{ color: "var(--text-faint)" }}>Deductible</span>
              <div className="mono font-medium">{fmtUsd(claim.deductibleCents)}</div>
            </div>
          )}
        </div>
      )}

      {/* Depreciation recovery (§G) — only when there is recoverable depreciation */}
      {depreciation && depreciation.recoverableCents > 0 && (
        <div className="space-y-3 rounded-md border border-border p-3" data-testid="depreciation-recovery">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Depreciation recovery</span>
            <span className="mono text-sm font-medium text-accent-gold" data-testid="depreciation-amount">
              {fmtUsd(depreciation.recoverableCents)}
            </span>
          </div>

          {depreciation.draftStatus === "none" && (
            <div className="space-y-2">
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Update the Xactimate pricing to current, then generate the recovery invoice. Enter the
                updated RCV (optional) — it re-prices the claim before drafting.
              </p>
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Updated RCV (optional)</label>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent-gold"
                    value={updatedRcvDollars}
                    onChange={(e) => setUpdatedRcvDollars(e.target.value)}
                    placeholder="e.g. 22000"
                    inputMode="decimal"
                  />
                </div>
                <Button onClick={handleGenerateRecovery} disabled={pending} data-testid="generate-recovery-invoice">
                  Generate recovery invoice
                </Button>
              </div>
            </div>
          )}

          {depreciation.draftStatus === "pending_approval" && depreciation.draftInvoiceId && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Draft recovery invoice is ready. Review, then send it to the carrier — nothing is sent
                without your approval.
              </p>
              <Button onClick={() => handleSendRecovery(depreciation.draftInvoiceId!)} disabled={pending} data-testid="send-recovery-invoice">
                Send to carrier
              </Button>
            </div>
          )}

          {depreciation.draftStatus === "sent" && (
            <p className="text-xs font-medium text-accent-gold" data-testid="depreciation-sent">
              Recovery invoice sent to the carrier ✓
            </p>
          )}

          {depHint && <p className="text-xs text-red-500">Couldn&apos;t complete that: {depHint}</p>}
        </div>
      )}
    </div>
  );
}
