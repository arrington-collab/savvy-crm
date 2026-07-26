import { NextResponse } from "next/server";
import { getTenantId } from "@/lib/tenant";
import { getActorHandle } from "@/lib/actor-handle";
import { signFlashToken } from "@/lib/flash-token";
import { loadEventsForDay, upsertDailyMetrics, listQueue } from "@savvy/db";
import { projectDay, businessDateOf, renderFlashHeadline, needsYouFor } from "@savvy/command-center";

export const runtime = "nodejs";

/**
 * On-demand "flash me now": regenerates today's metrics off the live event
 * log, persists them (same upsert the scheduled job would use), and returns
 * the headline plus a signed link to the full Flash page.
 *
 * "Needs you" is notify-membership for the calling actor, not primary
 * assignee: an escalation can name an operational role as the owner with a
 * person further down the `notify` list as oversight, and that person's
 * Flash still needs to surface it (see needsYouFor in @savvy/command-center,
 * which is also snooze-aware: open OR snoozed-past-its-snoozeUntil).
 */
export async function POST(): Promise<NextResponse> {
  const tenantId = await getTenantId();
  const actor = await getActorHandle();
  const today = businessDateOf(new Date());
  const metrics = projectDay(await loadEventsForDay(tenantId, today), today);
  await upsertDailyMetrics(tenantId, metrics);
  const queue = await listQueue(tenantId);
  const needsYou = needsYouFor(queue, actor, new Date());
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const token = signFlashToken(tenantId, today, actor);
  return NextResponse.json({
    businessDate: today,
    headline: renderFlashHeadline(metrics, needsYou),
    needsYou: needsYou.length,
    url: `${base}/flash/${token}`,
  });
}
