"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PartnerPicker, type PartnerSelection } from "@/components/PartnerPicker";
import { createCertRequestAction, bookCertRequestAction, declineCertRequestAction } from "@/lib/cert-actions";

type Row = {
  id: string;
  status: string;
  priceCents: number;
  requestedAt: string;
  deliveredAt: string | null;
  declineReason: string | null;
  certCode: string | null;
  address: string;
  partnerName: string;
  partnerOrg: string | null;
  priority: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  requested: "Requested", booked: "Booked", inspected: "Inspected", delivered: "Delivered", declined: "Declined",
};

function ageHours(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
}

export function CertsClient({ rows, reps }: { rows: Row[]; reps: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const [showNew, setShowNew] = useState(false);
  const [partnerSel, setPartnerSel] = useState<PartnerSelection | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [address, setAddress] = useState("");
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [assignee, setAssignee] = useState(reps[0]?.id ?? "");
  const [startsAt, setStartsAt] = useState("");

  function submitNew() {
    if (!partnerSel) { toast.error("Pick a partner"); return; }
    start(async () => {
      const r = await createCertRequestAction({
        partnerId: partnerSel.kind === "existing" ? partnerSel.id : undefined,
        partner: partnerSel.kind === "new" ? { name: partnerSel.name, org: partnerSel.org } : undefined,
        customerName, customerEmail: customerEmail || undefined, address,
      });
      if ("error" in r) { toast.error(r.error); return; }
      toast.success("Cert requested");
      setShowNew(false); setPartnerSel(null); setCustomerName(""); setCustomerEmail(""); setAddress("");
    });
  }

  function submitBook(id: string) {
    start(async () => {
      const r = await bookCertRequestAction({ certRequestId: id, assigneeUserId: assignee, startsAtIso: new Date(startsAt).toISOString() });
      if ("error" in r) { toast.error(r.error); return; }
      toast.success("Inspection booked");
      setBookingId(null); setStartsAt("");
    });
  }

  function decline(id: string) {
    const reason = window.prompt("Why is this cert declined?") ?? "";
    if (!reason.trim()) return;
    start(async () => {
      const r = await declineCertRequestAction(id, reason);
      if ("error" in r) toast.error(r.error);
    });
  }

  return (
    <div className="space-y-4">
      <div>
        {showNew ? (
          <Card className="max-w-md space-y-3 p-4" data-testid="cert-new-form">
            <div className="space-y-1.5">
              <Label>Partner</Label>
              <PartnerPicker value={partnerSel} onChange={setPartnerSel} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cert-customer">Homeowner / seller name</Label>
              <Input id="cert-customer" data-testid="cert-customer-name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cert-email">Delivery email (optional)</Label>
              <Input id="cert-email" data-testid="cert-customer-email" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cert-address">Property address</Label>
              <Input id="cert-address" data-testid="cert-address" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={pending || !customerName.trim() || !address.trim()} data-testid="cert-create" onClick={submitNew}>
                Request cert
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            </div>
          </Card>
        ) : (
          <Button size="sm" data-testid="cert-new" onClick={() => setShowNew(true)}>+ New cert request</Button>
        )}
      </div>

      <Card className="overflow-x-auto p-0" data-testid="cert-table">
        <table className="w-full text-sm">
          <thead>
            <tr className="mono text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              <th className="px-4 py-2.5 text-left">Status</th>
              <th className="px-4 py-2.5 text-left">Property</th>
              <th className="px-4 py-2.5 text-left">Partner</th>
              <th className="px-4 py-2.5 text-right">Price</th>
              <th className="px-4 py-2.5 text-right">Age</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center" style={{ color: "var(--text-faint)" }}>No cert requests yet.</td></tr>
            ) : rows.map((r) => {
              const open = r.status !== "delivered" && r.status !== "declined";
              const hrs = ageHours(r.requestedAt);
              return (
                <tr key={r.id} className="border-t align-top" style={{ borderColor: "var(--border-panel)" }} data-testid="cert-row">
                  <td className="px-4 py-2.5">
                    <span className="mono text-[11px]">{STATUS_LABEL[r.status] ?? r.status}</span>
                    {r.declineReason ? <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>{r.declineReason}</div> : null}
                  </td>
                  <td className="px-4 py-2.5">{r.address}</td>
                  <td className="px-4 py-2.5" style={{ color: "var(--text-muted)" }}>
                    {r.partnerName}{r.partnerOrg ? ` · ${r.partnerOrg}` : ""}
                    {r.priority ? <span className="mono ml-1 text-[10px]" style={{ color: "var(--accent-gold)" }}>priority</span> : null}
                  </td>
                  <td className="mono px-4 py-2.5 text-right">${(r.priceCents / 100).toFixed(0)}</td>
                  <td className="mono px-4 py-2.5 text-right"
                      style={{ color: open && hrs > 36 ? "var(--status-error)" : "var(--text-muted)" }}
                      data-testid="cert-age">
                    {open ? `${hrs}h` : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.status === "requested" && (bookingId === r.id ? (
                      <div className="flex flex-wrap items-center justify-end gap-2" data-testid="cert-book-form">
                        <select className="h-8 rounded-md border bg-transparent px-2 text-xs" value={assignee}
                                onChange={(e) => setAssignee(e.target.value)} data-testid="cert-book-assignee">
                          {reps.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                        <Input type="datetime-local" className="h-8 w-44 text-xs" value={startsAt}
                               onChange={(e) => setStartsAt(e.target.value)} data-testid="cert-book-start" />
                        <Button size="sm" disabled={pending || !startsAt || !assignee} data-testid="cert-book-confirm" onClick={() => submitBook(r.id)}>Book</Button>
                        <Button size="sm" variant="ghost" onClick={() => setBookingId(null)}>×</Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" data-testid="cert-book" onClick={() => setBookingId(r.id)}>Book inspection</Button>
                    ))}
                    {r.status === "delivered" && r.certCode && (
                      <a href={`/cert/${r.certCode}`} target="_blank" className="mono text-[12px] underline"
                         style={{ color: "var(--accent-deep)" }} data-testid="cert-link">
                        View cert →
                      </a>
                    )}
                    {open && (
                      <Button size="sm" variant="ghost" disabled={pending} className="ml-1" data-testid="cert-decline" onClick={() => decline(r.id)}>
                        Decline
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
