/**
 * Sage citations — the `get_job_ledger` / `get_task_health` "tools" rendered as
 * command-palette Q&A whose answers CITE ledger/health rows (never model memory).
 * Pure: the answer text is unit-tested; a thin client component dispatches these
 * into the AskSage palette. There is no LLM tool-calling — Sage is a palette.
 */
export type SageAnswer = { q: string; answer: string; actions?: { label: string; href: string }[] };

export type LedgerLite = {
  taskId: number;
  name: string;
  status: string; // job_task status: pending | blocked | done | verified | exception
  evidence: { type: string; ref: string } | null;
};

/** "get_job_ledger(job_id)" — is the job's work done, what's left, what's wrong. */
export function buildJobLedgerAnswers(jobId: string, rows: LedgerLite[]): SageAnswer[] {
  const total = rows.length;
  const verified = rows.filter((r) => r.status === "verified");
  const exceptions = rows.filter((r) => r.status === "exception");
  const inProgress = rows.filter((r) => r.status !== "verified" && r.status !== "exception");
  const open = [...exceptions, ...inProgress];

  const answers: SageAnswer[] = [];

  answers.push({
    q: "Is this job's work done?",
    answer:
      total === 0
        ? "No ledger tasks have been instantiated for this job yet."
        : `${verified.length} of ${total} tasks verified` +
          (exceptions.length ? `, ${exceptions.length} done-but-wrong` : "") +
          (inProgress.length ? `, ${inProgress.length} in progress` : "") + ".",
    actions: [{ label: "Open job", href: `/jobs/${jobId}` }],
  });

  answers.push({
    q: "What's left on this job?",
    answer:
      total === 0
        ? "Nothing yet — no ledger tasks for this job."
        : open.length === 0
          ? "Everything's verified — nothing left."
          : `Open: ${open.map((r) => `${r.name} (${r.status})`).join(", ")}.`,
  });

  if (exceptions.length) {
    answers.push({
      q: "Anything done-but-wrong on this job?",
      answer: exceptions.map((r) => `${r.name}${r.evidence ? ` [${r.evidence.type}:${r.evidence.ref}]` : ""}`).join(", ") + ".",
      actions: [{ label: "Open task", href: `/tasks/${exceptions[0]!.taskId}` }],
    });
  }

  return answers;
}

export type TaskHealthLite = {
  taskId: number;
  name: string;
  healthStatus: string | null; // green | amber | red | gray | null
  latestVerification: string | null; // pass | fail | stale | skip | null
  exception: { kind: string; severity: string } | null;
};

/** "get_task_health(task_id)" — is this task healthy, citing status + last check + open exception. */
export function buildTaskHealthAnswer(d: TaskHealthLite): SageAnswer[] {
  const parts = [`${d.name} is ${d.healthStatus ?? "unscored"}`];
  if (d.latestVerification) parts.push(`last check ${d.latestVerification}`);
  if (d.exception) parts.push(`open ${d.exception.severity} ${d.exception.kind}`);
  return [
    {
      q: `Is "${d.name}" healthy?`,
      answer: parts.join(" · ") + ".",
      actions: [{ label: "Open task", href: `/tasks/${d.taskId}` }],
    },
  ];
}

/** "get_valuation(latest)" — what's the company worth, and why. Owner's Room S3. */
export function buildValuationAnswers(snapshot: {
  status: string;
  periodKey: string;
  valueLowCents: number | null;
  valueHighCents: number | null;
  adjustments: { key: string; rationale: string }[];
  reasons?: string[] | null;
}): SageAnswer[] {
  const usdM = (c: number) => {
    const m = c / 100_000_000;
    return m >= 1 ? `$${m.toFixed(1)}M` : `$${Math.round(c / 100_000)}K`;
  };
  const actions = [{ label: "Open the Owner's Room", href: "/money/owners-room" }];

  if (snapshot.status !== "ok" || snapshot.valueLowCents == null || snapshot.valueHighCents == null) {
    return [{
      q: "What's my company worth?",
      answer:
        "Not enough real operating data to price honestly yet — " +
        `${(snapshot.reasons ?? []).join("; ") || "critical inputs are missing"}. ` +
        "The room shows a range only when it comes from your data, never placeholders.",
      actions,
    }];
  }

  const ledger = snapshot.adjustments.map((a) => a.rationale).join(" · ");
  return [{
    q: "What's my company worth?",
    answer:
      `Planning range ${usdM(snapshot.valueLowCents)} – ${usdM(snapshot.valueHighCents)} as of ${snapshot.periodKey}, ` +
      `from your operating data: ${ledger || "base multiple only"}. ` +
      "This is not an appraisal or financial advice.",
    actions,
  }];
}
