// Alta cutover — AccuLynx → Savvy vocabulary mapping. Pure functions consumed
// by the one-shot importer (db/lifecycle/acculynx-import). AccuLynx milestones:
// Lead (assigned, not yet a job) · Prospect · Approved · Completed (work done,
// pre-invoice) · Invoiced · Closed · Dead (canceled/lost). Dead records import
// as lost jobs on purpose — they're marketing history and Strike List fuel,
// not garbage.

import type { JobStage } from "./enums";
import type { LeadSourceValue } from "./lead-sources";

export type MilestoneMapping = { kind: "lead" } | { kind: "job"; stage: JobStage };

export function mapAccuLynxMilestone(milestone: string): MilestoneMapping {
  switch (milestone) {
    case "Prospect": return { kind: "job", stage: "estimate" };
    case "Approved": return { kind: "job", stage: "approved" };
    case "Completed": return { kind: "job", stage: "closeout" };
    case "Invoiced": return { kind: "job", stage: "billing" };
    case "Closed": return { kind: "job", stage: "complete" };
    case "Dead": return { kind: "job", stage: "lost" };
    // "Lead" and anything unrecognized lands as a lead — a human triages it
    // rather than the importer silently dropping a record.
    default: return { kind: "lead" };
  }
}

// Observed Alta values → Savvy's controlled source taxonomy; the original
// wording always survives in `detail` (stored in lead.source_detail).
const SOURCE_MAP: Record<string, LeadSourceValue> = {
  referral: "referral",
  internet: "web",
  angie: "ads", // Angi leads are a paid channel
  personal: "other",
  other: "other",
};

export function mapAccuLynxLeadSource(raw: string | null | undefined): { source: LeadSourceValue; detail: string | null } {
  const detail = raw ?? null;
  const source = SOURCE_MAP[(raw ?? "").trim().toLowerCase()] ?? "other";
  return { source, detail };
}

/** AccuLynx WorkTypes → Savvy job.type. Insurance wins when both appear. */
export function mapAccuLynxWorkType(workTypes: readonly string[] | undefined): "retail" | "insurance" {
  return workTypes?.some((w) => w.trim().toLowerCase() === "insurance") ? "insurance" : "retail";
}

export interface AccuLynxContactCsvRow {
  contactId: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
}

/** Minimal RFC-4180 field splitter — the mailing-address column carries commas
 *  inside quotes, so a naive split corrupts every row. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const CONTACT_GUID = /\/contacts\/([0-9a-f-]{36})\//i;

/** Parse the AccuLynx "Contacts Report" CSV export. The contact GUID (the
 *  idempotency key) is extracted from the profile-URL column; rows without one
 *  are skipped rather than imported untraceably. */
export function parseAccuLynxContactsCsv(csv: string): AccuLynxContactCsvRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: AccuLynxContactCsvRow[] = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const guid = CONTACT_GUID.exec(f[8] ?? "")?.[1];
    if (!guid) continue;
    rows.push({
      contactId: guid,
      name: [f[0], f[1]].filter(Boolean).join(" ").trim(),
      phone: f[5]?.trim() || null,
      email: f[6]?.trim() || null,
      address: f[4]?.trim() || null,
    });
  }
  return rows;
}
