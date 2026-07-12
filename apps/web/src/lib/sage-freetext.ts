import "server-only";
import { buildJobLedgerAnswers, matchJobByName, type LedgerLite } from "@savvy/core";
import { withTenant, job, customer, eq, inArray, getJobLedger } from "@savvy/db";

const OPEN_STAGES = ["inspected", "estimate", "approved", "production", "closeout", "billing"] as const;

/**
 * Free-text Sage over SMS: resolve a job by customer name, then return the
 * top cited ledger answer (the same buildJobLedgerAnswers the in-app Ask Sage
 * uses — cites job_task rows + evidence, never model memory). No match → guidance.
 */
export async function answerSageFreeText(tenantId: string, text: string): Promise<string> {
  const candidates = await withTenant(tenantId, (tx) =>
    tx
      .select({ jobId: job.id, name: customer.name })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .where(inArray(job.stage, [...OPEN_STAGES])),
  );
  const match = matchJobByName(text, candidates);
  if (!match) return "Ask me about a job by name (e.g. \"Hendricks\"), or text HELP for your queue.";

  const rows = (await getJobLedger(tenantId, match.jobId)) as unknown as LedgerLite[];
  const answers = buildJobLedgerAnswers(match.jobId, rows);
  const headline = answers[0]?.answer ?? "No ledger yet for that job.";
  return `${match.name}: ${headline}`;
}
