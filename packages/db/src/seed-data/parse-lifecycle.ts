import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PHASE_TO_STAGE } from "./templates";
import { JOB_TYPE } from "@savvy/core";

const here = dirname(fileURLToPath(import.meta.url));

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const AGENT: Record<string, string | null> = {
  "Comms Agent": "comms", "Orchestrator": "orchestrator", "Scheduling Agent": "scheduling",
  "Finance Agent": "finance", "Claims Agent": "claims", "N/A": null, "": null,
};
const AUTO: Record<string, "full" | "partial" | "manual"> = {
  "Full Auto": "full", "Partial Auto": "partial", "Manual": "manual",
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function main() {
  const rows = parseCsv(readFileSync(join(here, "task-lifecycle-212.csv"), "utf8"));
  const out = [];
  for (const r of rows) {
    if (!/^\d+$/.test((r[0] ?? "").trim())) continue;
    const num = Number(r[0]);
    const phase = (r[2] ?? "").trim();
    const stageOrOrg = PHASE_TO_STAGE[phase];
    if (stageOrOrg === undefined) throw new Error(`Unmapped phase: "${phase}" (task ${num})`);
    const orgLevel = stageOrOrg === "ORG";
    const jt = (r[3] ?? "").trim();
    const jobTypes = jt === "All" ? [...JOB_TYPE] : [jt.toLowerCase()];
    out.push({
      key: `${slug(phase)}-${String(num).padStart(3, "0")}`,
      num,
      title: (r[1] ?? "").trim(),
      phase,
      stage: orgLevel ? null : stageOrOrg,
      orgLevel,
      jobTypes,
      automationLevel: AUTO[(r[4] ?? "").trim()] ?? "manual",
      ownerAgent: AGENT[(r[8] ?? "").trim()] ?? null,
      ownerRole: (r[7] ?? "").trim(),
      trigger: (r[6] ?? "").trim(),
      difficulty: Number((r[9] ?? "0").trim()) || 0,
      whatGetsAutomated: (r[5] ?? "").trim(),
    });
  }
  writeFileSync(join(here, "task-lifecycle.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`parsed ${out.length} task templates`);
}
main();
