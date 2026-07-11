/**
 * Plain-words map for agent_run.task_key. The feed, cards, and shift report all
 * render THIS, never the dotted machine key. Unknown keys humanize as a fallback
 * (category = first dotted segment) so a new taskKey is legible on day one.
 */
const VERBS: Record<string, { verb: string; category: string }> = {
  "lead.rep.alert": { verb: "alerted the rep", category: "lead" },
  "lead.speed_to_contact": { verb: "made first contact", category: "lead" },
  "lead.calibration": { verb: "recalibrated lead scoring", category: "lead" },
  "ops.digest": { verb: "sent the daily digest", category: "ops" },
  "estimate.generate": { verb: "drafted an estimate", category: "estimate" },
  "lead.doc_parse": { verb: "parsed a document", category: "lead" },
  "drip.append": { verb: "sent a follow-up", category: "comms" },
  "finance.dunning": { verb: "chased a late invoice", category: "finance" },
  "finance.commissions": { verb: "calculated a commission", category: "finance" },
  "enrichment.property": { verb: "enriched a property", category: "enrichment" },
};

function humanize(taskKey: string): { verb: string; category: string } {
  const parts = taskKey.split(".");
  const category = parts[0] || "agent";
  const rest = parts.slice(1);
  const words = rest.join(" ").replace(/[_.]/g, " ").trim() || category;
  return { verb: words, category };
}

export function verbFor(taskKey: string | null): { verb: string; category: string } {
  if (!taskKey) return { verb: "took an action", category: "agent" };
  return VERBS[taskKey] ?? humanize(taskKey);
}
