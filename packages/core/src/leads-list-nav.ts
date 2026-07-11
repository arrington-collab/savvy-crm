import { LEAD_STATUS } from "./enums";

/**
 * Leads-list navigation state (slice 4). When a rep opens a lead from the list we
 * carry the list's current filters in an opaque `?from` param so the tile's
 * "← Back to Leads" button can return them to the exact same filtered view.
 * Scroll position is handled separately (session storage on the list itself).
 *
 * Everything here is allow-listed: only `status` (a real LEAD_STATUS) and a
 * non-default `sort` (`age`) survive a round-trip, so a hand-crafted `?from` can
 * never reflect arbitrary/injected query params back into a link. The default
 * `score` sort is omitted — returning to a bare `/leads` already sorts by score,
 * so a default-view row keeps a clean `/leads/{id}` href (no `?from`).
 */
export type LeadsListFilters = { status?: string | null; sort?: string | null };

/** Canonical, allow-listed query string for a leads-list view (empty when default). */
function cleanLeadsListQuery(f: LeadsListFilters): string {
  const params = new URLSearchParams();
  if (f.status && (LEAD_STATUS as readonly string[]).includes(f.status)) params.set("status", f.status);
  if (f.sort === "age") params.set("sort", "age"); // "score" is the default → omit
  return params.toString();
}

/** Href for a lead row, carrying the current list filters as `?from`. */
export function buildLeadRowHref(leadId: string, f: LeadsListFilters): string {
  const qs = cleanLeadsListQuery(f);
  return qs ? `/leads/${leadId}?from=${encodeURIComponent(qs)}` : `/leads/${leadId}`;
}

/** Rebuild the leads-list href from a `?from` value, dropping anything unrecognized. */
export function parseLeadsListReturn(from: string | null | undefined): string {
  if (!from) return "/leads";
  let decoded: string;
  try {
    decoded = decodeURIComponent(from);
  } catch {
    return "/leads";
  }
  const sp = new URLSearchParams(decoded);
  const qs = cleanLeadsListQuery({ status: sp.get("status"), sort: sp.get("sort") });
  return qs ? `/leads?${qs}` : "/leads";
}
