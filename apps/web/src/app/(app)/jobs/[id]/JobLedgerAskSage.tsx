"use client";
import { useEffect } from "react";
import { buildJobLedgerAnswers, type LedgerLite } from "@savvy/core";

/**
 * Registers the get_job_ledger Sage citations for this job (renders nothing).
 * The single AskSage palette merges these ahead of its static defaults, so
 * "is this job done?" is answered by citing the ledger, not model memory.
 */
export function JobLedgerAskSage({ jobId, rows }: { jobId: string; rows: LedgerLite[] }) {
  useEffect(() => {
    const qs = buildJobLedgerAnswers(jobId, rows);
    window.dispatchEvent(new CustomEvent("ask-sage:set", { detail: qs }));
    return () => { window.dispatchEvent(new CustomEvent("ask-sage:set", { detail: [] })); };
  }, [jobId, rows]);
  return null;
}
