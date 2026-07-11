/**
 * Plain-words map for agent_run.task_key. The feed, cards, and shift report all
 * render THIS, never the dotted machine key. Unknown keys humanize as a fallback
 * (category = first dotted segment) so a new taskKey is legible on day one.
 */
const VERBS: Record<string, { verb: string; category: string }> = {
  "enrich.property": { verb: "enriched a property", category: "enrich" },
  "change-order.apply": { verb: "applied a change order", category: "change-order" },
  "change-order.ai-draft": { verb: "drafted a change order", category: "change-order" },
  "change-order.auto-send-invoice": { verb: "sent a change-order invoice", category: "change-order" },
  "lead.qualify": { verb: "qualified a lead", category: "lead" },
  "lead.assign": { verb: "assigned a lead", category: "lead" },
  "lead.rep.alert": { verb: "alerted the rep", category: "lead" },
  "measurement.auto_order": { verb: "ordered a measurement", category: "measurement" },
  "lead.sla.overdue": { verb: "flagged an overdue lead", category: "lead" },
  "lead.sla.escalated": { verb: "escalated an overdue lead", category: "lead" },
  "lead.voice.fallback": { verb: "fell back to voice", category: "lead" },
  "lead.calibration": { verb: "recalibrated lead scoring", category: "lead" },
  "lead.rescore.upgraded": { verb: "rescored a lead", category: "lead" },
  "ops.digest": { verb: "sent the daily digest", category: "ops" },
  "ops.health_sweep": { verb: "ran the health sweep", category: "ops" },
  "ops.break_glass": { verb: "broke glass", category: "ops" },
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
