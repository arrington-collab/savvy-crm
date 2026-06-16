"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sendForSignature } from "@/lib/esign-actions";
import { presignDocumentView } from "@/lib/document-actions";

export type EsignRow = {
  id: string;
  docType: string;
  status: string;
  signingUrl: string | null;
  documentId: string | null;
};

function statusBadge(status: string) {
  if (status === "completed") return <Badge variant="secondary">Completed</Badge>;
  if (status === "declined") return <Badge variant="destructive">Declined</Badge>;
  if (status === "voided") return <Badge variant="outline">Voided</Badge>;
  return <Badge variant="outline">Sent</Badge>;
}

const DOC_LABEL: Record<string, string> = { lien_waiver: "Lien waiver", cert: "Certificate of completion" };

export function EsignPanel({
  jobId,
  customerEmail,
  requests,
}: {
  jobId: string;
  customerEmail: string | null;
  requests: EsignRow[];
}) {
  const [docType, setDocType] = useState<"lien_waiver" | "cert">("lien_waiver");
  const [busy, setBusy] = useState(false);

  async function handleSend() {
    setBusy(true);
    const res = await sendForSignature({ jobId, docType });
    setBusy(false);
    if ("ok" in res) {
      toast.success("Sent for signature — DocuSeal emailed the customer.");
    } else if (res.error === "no_customer_email") {
      toast.error("Add a customer email before sending for signature.");
    } else if (res.error === "no_template") {
      toast.error("No DocuSeal template configured for this document type yet.");
    } else if (res.error === "docuseal_failed") {
      toast.error("DocuSeal is not configured or unreachable.");
    } else {
      toast.error("Could not send for signature.");
    }
  }

  async function copyLink(url: string) {
    await navigator.clipboard.writeText(url);
    toast.success("Signing link copied.");
  }

  async function viewSigned(documentId: string) {
    const res = await presignDocumentView(documentId);
    if ("ok" in res) window.open(res.url, "_blank", "noreferrer");
    else toast.error("Could not load the signed document.");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <select
          value={docType}
          onChange={(e) => setDocType(e.target.value as "lien_waiver" | "cert")}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          aria-label="Document type"
        >
          <option value="lien_waiver">Lien waiver</option>
          <option value="cert">Certificate of completion</option>
        </select>
        <Button onClick={handleSend} disabled={busy || !customerEmail}>
          {busy ? "Sending…" : "Send for signature"}
        </Button>
        {!customerEmail && <span className="text-xs text-muted-foreground">Customer email required</span>}
      </div>

      {requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">No signature requests yet.</p>
      ) : (
        <ul className="space-y-2">
          {requests.map((r) => (
            <li key={r.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                {statusBadge(r.status)}
                <span>{DOC_LABEL[r.docType] ?? r.docType}</span>
              </span>
              <span className="flex items-center gap-2">
                {r.status === "sent" && r.signingUrl && (
                  <Button variant="outline" size="sm" onClick={() => copyLink(r.signingUrl!)}>
                    Copy link
                  </Button>
                )}
                {r.status === "completed" && r.documentId && (
                  <Button variant="outline" size="sm" onClick={() => viewSigned(r.documentId!)}>
                    View signed PDF
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
