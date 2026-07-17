"use client";
import { useEffect } from "react";
import { buildValuationAnswers } from "@savvy/core";

/**
 * Registers the get_valuation Sage citations (renders nothing). "What's my
 * company worth?" answers from the latest snapshot with the adjustment ledger
 * cited — never model memory. Same palette pattern as JobLedgerAskSage.
 */
export function ValuationAskSage({ snapshot }: { snapshot: Parameters<typeof buildValuationAnswers>[0] }) {
  useEffect(() => {
    const qs = buildValuationAnswers(snapshot);
    window.dispatchEvent(new CustomEvent("ask-sage:set", { detail: qs }));
    return () => { window.dispatchEvent(new CustomEvent("ask-sage:set", { detail: [] })); };
  }, [snapshot]);
  return null;
}
