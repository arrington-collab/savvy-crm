"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { justCompleted } from "@savvy/core";
import { useInflight } from "@/components/inflight/InflightProvider";

/**
 * Live fill-in for a lead's enrichment. Watches the lead's in-flight run (the same
 * 15s poll that drives the dots); when a run that was in-flight finishes, pulls
 * fresh server data so null property fields fill in without a manual reload. No
 * run → nothing happens and the server-rendered value stands (no animation).
 */
export function EnrichmentLive({ leadId }: { leadId: string }) {
  const router = useRouter();
  const run = useInflight("lead", leadId);
  const prev = useRef(run);

  useEffect(() => {
    if (justCompleted(prev.current, run)) router.refresh();
    prev.current = run;
  }, [run, router]);

  return null;
}
