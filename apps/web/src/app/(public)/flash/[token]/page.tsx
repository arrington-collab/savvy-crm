import { getDailyMetrics, listQueue } from "@savvy/db";
import { compareMetrics, renderFlashHtml } from "@savvy/command-center";
import { addDays } from "@savvy/core";
import { verifyFlashToken } from "@/lib/flash-token";

export const dynamic = "force-dynamic";

/**
 * Signed Flash page: the token (packages/web/src/lib/flash-token.ts) carries
 * tenantId + businessDate, verified on every view — no DB-backed link table,
 * same stateless recipe as the status-photo proxy. Renders the same
 * self-contained HTML the SMS/email delivery would link to.
 */
export default async function FlashPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const payload = verifyFlashToken(token);
  const metrics = payload ? await getDailyMetrics(payload.tenantId, payload.businessDate) : null;

  if (!payload || !metrics) {
    return (
      <main className="mx-auto min-h-screen max-w-md bg-white p-8 text-center text-stone-800" data-testid="flash-invalid">
        <h1 className="text-xl font-semibold">Flash not available</h1>
        <p className="mt-2 text-stone-500">This link is invalid or expired, or today&apos;s Flash hasn&apos;t been generated yet.</p>
      </main>
    );
  }

  const { tenantId, businessDate } = payload;
  const yesterday = await getDailyMetrics(tenantId, addDays(businessDate, -1));
  const trailingDates = Array.from({ length: 7 }, (_, i) => addDays(businessDate, -(i + 1)));
  const trailing7 = (
    await Promise.all(trailingDates.map((d) => getDailyMetrics(tenantId, d)))
  ).filter((m): m is NonNullable<typeof m> => m !== null);
  const comparison = compareMetrics(metrics, yesterday, trailing7);

  const queue = await listQueue(tenantId);
  const needsYou = queue.filter((i) => i.notify.includes("arrington") && i.state === "open");

  const html = renderFlashHtml(metrics, needsYou, comparison);

  return (
    <main className="min-h-screen bg-white text-stone-800" data-testid="flash-page">
      {/* renderFlashHtml escapes all interpolated fields (see esc() in flash.ts) */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
