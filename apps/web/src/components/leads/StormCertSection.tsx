"use client";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getStormCertDownloadUrl } from "@/app/(app)/leads/[id]/storm-cert-actions";

type StormCertStatus = "pending" | "verified" | "none" | "error";

interface StormCertSectionProps {
  stormCertStatus: StormCertStatus;
  stormCheckedAt: Date | null;
  /** Whether the lead has a cert document attached (controls download button visibility). */
  stormCertDocumentId: string | null;
  /** The lead's own id — passed to the server action so it resolves the doc server-side (IDOR fix). */
  leadId: string;
}

export function StormCertSection({
  stormCertStatus,
  stormCheckedAt,
  stormCertDocumentId,
  leadId,
}: StormCertSectionProps) {
  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    if (!stormCertDocumentId) return;
    setDownloading(true);
    try {
      const url = await getStormCertDownloadUrl(leadId);
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } finally {
      setDownloading(false);
    }
  }

  const checkedLabel = stormCheckedAt
    ? `Checked ${new Date(stormCheckedAt).toLocaleDateString()}`
    : null;

  if (stormCertStatus === "verified") {
    return (
      <div className="rounded-md border p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="border-green-600 text-green-700 dark:border-green-400 dark:text-green-400">
            Storm Certified
          </Badge>
          {checkedLabel && (
            <span className="text-xs text-muted-foreground">{checkedLabel}</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          A qualifying storm event was verified at this address.
        </p>
        {stormCertDocumentId && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? "Opening…" : "Download certificate"}
          </Button>
        )}
      </div>
    );
  }

  if (stormCertStatus === "none") {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">No storm data</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          No verified storm in the last 24 months{checkedLabel ? ` (${checkedLabel.toLowerCase()})` : ""}.
        </p>
      </div>
    );
  }

  if (stormCertStatus === "pending") {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="border-yellow-500 text-yellow-600 dark:text-yellow-400">
          Checking…
        </Badge>
        <span className="text-xs text-muted-foreground">Storm check in progress</span>
      </div>
    );
  }

  // error
  return (
    <div className="flex items-center gap-2">
      <Badge variant="destructive">Check failed</Badge>
      <span className="text-xs text-muted-foreground">Storm check failed — will retry automatically</span>
    </div>
  );
}
