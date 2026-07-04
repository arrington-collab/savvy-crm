"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { presignDocumentView, keepFlaggedPhoto } from "@/lib/document-actions";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export interface FlaggedPhoto {
  documentId: string;
  label: string | null;
  reason: string;
}

// Presigns a view URL on mount and renders the thumbnail (mirrors DocsPanel's DocThumb).
function Thumb({ docId, alt }: { docId: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    presignDocumentView(docId)
      .then((res) => {
        if (cancelled) return;
        if ("ok" in res) setSrc(res.url);
        else setFailed(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [docId]);
  if (failed) return <div className="flex h-24 w-24 items-center justify-center rounded-md border border-border bg-muted text-xs text-muted-foreground">unavailable</div>;
  if (!src) return <div className="h-24 w-24 animate-pulse rounded-md bg-muted" aria-label="Loading photo" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className="h-24 w-24 rounded-md border border-border object-cover" />;
}

function KeepButton({ docId }: { docId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function onKeep() {
    startTransition(async () => {
      const res = await keepFlaggedPhoto(docId);
      if ("ok" in res) {
        toast.success("Photo kept");
        router.refresh();
      } else {
        toast.error("Could not keep photo");
      }
    });
  }
  return (
    <Button size="sm" variant="outline" onClick={onKeep} disabled={pending} data-testid="keep-flagged-photo">
      {pending ? "Keeping…" : "Keep"}
    </Button>
  );
}

export function FlaggedPhotosPanel({ jobId: _jobId, documents }: { jobId: string; documents: FlaggedPhoto[] }) {
  if (documents.length === 0) return null;
  return (
    <Card data-testid="flagged-photos-panel">
      <CardHeader><CardTitle>Flagged photos</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {documents.map((d) => (
          <div key={d.documentId} className="flex items-center gap-3" data-testid="flagged-photo-row">
            <Thumb docId={d.documentId} alt={d.label ?? "flagged photo"} />
            <div className="flex-1">
              <div className="text-sm font-medium">{d.label ?? "Photo"}</div>
              <div className="text-xs" style={{ color: "var(--text-faint)" }}>{d.reason}</div>
            </div>
            <KeepButton docId={d.documentId} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
