import { NextResponse } from "next/server";
import { getTenantId } from "@/lib/tenant";
import { signFlashToken } from "@/lib/flash-token";
import { loadEventsForDay, upsertDailyMetrics, listQueue } from "@savvy/db";
import { projectDay, businessDateOf, renderFlashHeadline } from "@savvy/command-center";

export const runtime = "nodejs";

/**
 * On-demand "flash me now": regenerates today's metrics off the live event
 * log, persists them (same upsert the scheduled job would use), and returns
 * the headline plus a signed link to the full Flash page.
 *
 * "Needs you" is notify-membership, not primary assignee: an escalation can
 * name an operational role as the owner with a person further down the
 * `notify` list as oversight, and that person's Flash still needs to surface
 * it (see ExceptionQueue.needsYou in @savvy/command-center).
 */
export async function POST(): Promise<NextResponse> {
  const tenantId = await getTenantId();
  const today = businessDateOf(new Date());
  const metrics = projectDay(await loadEventsForDay(tenantId, today), today);
  await upsertDailyMetrics(tenantId, metrics);
  const queue = await listQueue(tenantId);
  const needsYou = queue.filter((i) => i.notify.includes("arrington") && i.state === "open");
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const token = signFlashToken(tenantId, today);
  return NextResponse.json({
    businessDate: today,
    headline: renderFlashHeadline(metrics, needsYou),
    needsYou: needsYou.length,
    url: `${base}/flash/${token}`,
  });
}
