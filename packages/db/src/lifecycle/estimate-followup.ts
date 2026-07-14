// Estimate Experience slice 6: the value-adding follow-up sequence — every
// touch ADDS something, never "just checking in". Day 1 is the owner video
// (slice 5b's delivery cron — deliberately NOT a step here, one send path).
// Rides the drip rails: Library-versioned templates, suppression, throttle,
// demo-mute, and the drip/stop cancel on acceptance all come for free.

import { eq, and } from "drizzle-orm";
import { withTenant } from "../tenant";
import { drip, messageTemplate } from "../schema/comms";
import type { DripStep } from "@savvy/core";

export const ESTIMATE_FOLLOWUP_DRIP_KEY = "estimate-followup";

const TEMPLATES: { key: string; name: string; body: string }[] = [
  {
    key: "estimate-followup-day4",
    name: "Estimate follow-up — day 4 (Why Us + warranty)",
    body:
      "Hi {{firstName}} — one thing most bids don't show: what happens AFTER install. " +
      "Ours carries the manufacturer's shingle warranty AND our own workmanship warranty. " +
      "The details are on your estimate: {{estimateLink}}",
  },
  {
    key: "estimate-followup-day8",
    name: "Estimate follow-up — day 8 (monthly payment)",
    body:
      "Hi {{firstName}} — your roof doesn't have to be a lump sum. " +
      "There's a monthly-payment option on your estimate now: {{estimateLink}}",
  },
  {
    key: "estimate-followup-color",
    name: "Estimate follow-up — color render (inactive slot)",
    body:
      "Hi {{firstName}} — want to see the colors on YOUR actual roof? " +
      "We rendered your top picks: {{estimateLink}}",
  },
  {
    key: "estimate-followup-day20",
    name: "Estimate follow-up — day 20 (validity reminder)",
    body:
      "Hi {{firstName}} — heads up: your estimate's pricing is locked through {{validUntil}}. " +
      "Material costs move after that, so if it's still on your mind: {{estimateLink}}",
  },
];

// Cumulative from send: day 4 → day 8 → day 12 (dormant color slot) → day 20.
const STEPS: DripStep[] = [
  { stepNum: 1, delayHours: 96, channel: "sms", templateKey: "estimate-followup-day4" },
  { stepNum: 2, delayHours: 96, channel: "sms", templateKey: "estimate-followup-day8", gate: "financing_live" },
  { stepNum: 3, delayHours: 96, channel: "sms", templateKey: "estimate-followup-color", gate: "feature:color_render" },
  { stepNum: 4, delayHours: 192, channel: "sms", templateKey: "estimate-followup-day20" },
];

/** Seeds the sequence + its Library templates for a tenant. Idempotent. */
export async function ensureEstimateFollowupDrip(tenantId: string): Promise<{ seeded: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: drip.id })
      .from(drip)
      .where(and(eq(drip.tenantId, tenantId), eq(drip.key, ESTIMATE_FOLLOWUP_DRIP_KEY)));
    if (existing) return { seeded: false };

    for (const t of TEMPLATES) {
      await tx
        .insert(messageTemplate)
        .values({ tenantId, key: t.key, name: t.name, channel: "sms", body: t.body })
        .onConflictDoNothing();
    }
    await tx.insert(drip).values({
      tenantId,
      key: ESTIMATE_FOLLOWUP_DRIP_KEY,
      name: "Estimate follow-up (value-adding)",
      triggerEvent: "estimate/sent",
      steps: STEPS,
    });
    return { seeded: true };
  });
}
