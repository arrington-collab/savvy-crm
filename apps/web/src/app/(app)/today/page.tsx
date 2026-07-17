import Link from "next/link";
import { Card } from "@/components/ui/card";
import { VideoBatchCard } from "./VideoBatchCard";
import { StormBatchCard } from "./StormBatchCard";
import { MoveVerificationCard } from "./MoveVerificationCard";
import { PartnerMergeCard } from "./PartnerMergeCard";
import { PartnerGradeCard } from "./PartnerGradeCard";
import { BlitzApprovalCard } from "./BlitzApprovalCard";
import { FillApprovalCard } from "./FillApprovalCard";
import { BoostCard } from "./BoostCard";
import { LeftoverCard } from "./LeftoverCard";
import { CoverageMap } from "@/components/cockpit/CoverageMap";
import { LockedTile } from "@/components/cockpit/LockedTile";
import { getExceptionQueue } from "@/lib/exception-queries";
import { loadOpenTaskExceptions, loadTenantRollup } from "@/lib/scoreboard-queries";
import { getTodayMoney, getTodayDigest, getTenantIdentity } from "@/lib/today-queries";
import { getOnboardingStatus } from "@/lib/onboarding-queries";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import { Odometer } from "@/components/odometer/Odometer";
import { summarizeTenantCoverage, estimateDecisionMinutes, isOnboardingComplete, describeOdometer, visibleExceptionsFor } from "@savvy/core";
import { getCurrentUser } from "@/lib/current-user";
import { getPortfolioValuationLine } from "@/lib/valuation-queries";
import { A2P_REGISTRATION_STEPS } from "@/lib/deliverability-copy";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

// Chip labels mirror the legacy exceptions worklist so semantics (and e2e text
// assertions) stay stable; the mockup's SUPPLEMENT/CASH/etc. chips are just
// illustrative categories over these finer-grained kinds.
const KIND_LABEL: Record<string, string> = {
  job_at_risk: "Job at risk", invoice_overdue: "Invoice overdue", appointment_missed: "Appointment",
  task_overdue: "Task overdue", material_delivery: "Materials", task_needs_approval: "Needs approval",
  weather_at_risk: "Weather risk", roof_type_needed: "Roof type", margin_outlier: "Margin",
  photo_incomplete: "Photos", photo_quality: "Photo QC", photo_unmatched: "Unmatched photo",
  verification_mismatch: "Done-but-wrong", task_stale: "Stale check", task_regression: "Regressed",
  supplier_invoice_unmatched: "Unmatched invoice",
  supplier_credit_review: "Credit request",
  supplier_credit_reconcile: "Reconcile credit",
  comms_deliverability: "SMS deliverability",
};

type Decision = { kind: string; severity: "high" | "medium"; title: string; detail: string; href: string; occurredAt: Date | null; checkKey?: string | null };

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function usdK(cents: number): string {
  const k = cents / 100000;
  return k >= 1 ? `$${k.toFixed(1)}k` : usd(cents);
}
function ago(d: Date | null): string {
  if (!d) return "";
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default async function TodayPage() {
  const [{ role }, queue, allTaskExceptions, money, digest, rollup, identity, onboarding] = await Promise.all([
    getCurrentUser(),
    getExceptionQueue(),
    loadOpenTaskExceptions(),
    getTodayMoney(),
    getTodayDigest(),
    loadTenantRollup(),
    getTenantIdentity(),
    getOnboardingStatus(),
  ]);
  const showChecklist = !onboarding.state.dismissed && !isOnboardingComplete(onboarding.steps);
  // Owner's Room S2: the empire scoreboard line — valuation is owner-tier, so
  // it loads only when the viewer isn't office (never fetched, not just hidden).
  const valuationLine = role !== "office" ? await getPortfolioValuationLine().catch(() => null) : null;

  // S6 matrix: office runs the day (scheduling, doc chasing, collections) but
  // owner-tier cards — money approvals, break-glass, dollars-at-risk — never
  // render for it (the #354 invariant). Everyone else sees everything.
  const isOffice = role === "office";
  const scopedItems = visibleExceptionsFor(role, queue.items);
  const taskExceptions = isOffice
    ? allTaskExceptions.filter((e) => !e.breakGlass && e.dollarImpactCents <= 0)
    : allTaskExceptions;

  // One ranked worklist: operational vectors + scoreboard task exceptions (which
  // cite a task and deep-link its proof page). High severity first — same merge
  // the old /exceptions page used, now the Today decision queue.
  const decisions: Decision[] = [
    ...scopedItems.map((i) => ({ kind: i.kind, severity: i.severity, title: i.title, detail: i.detail, href: i.href, occurredAt: i.occurredAt })),
    ...taskExceptions.map((e) => ({
      kind: e.kind,
      severity: (e.severity === "high" ? "high" : "medium") as "high" | "medium",
      title: e.name,
      detail: e.dollarImpactCents > 0 ? `${usd(e.dollarImpactCents)} at risk` : KIND_LABEL[e.kind] ?? e.kind,
      href: `/tasks/${e.taskId}`,
      occurredAt: null,
      checkKey: e.checkKey,
    })),
  ];
  decisions.sort((a, b) => (a.severity === "high" ? 0 : 1) - (b.severity === "high" ? 0 : 1));

  const coverage = summarizeTenantCoverage(rollup);
  const estMinutes = estimateDecisionMinutes(decisions.length);
  const today = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: identity.timezone }).format(new Date());
  const odometer = describeOdometer(digest.totalActions, digest.minutesSaved);

  return (
    <div className="space-y-7" data-testid="today-page">
      {showChecklist && <OnboardingChecklist steps={onboarding.steps} />}
      {/* PORTFOLIO STRIP — owner-tier cards (money approvals, partner ledger)
          never render for office (S6 #354 invariant). */}
      <VideoBatchCard />
      <StormBatchCard />
      <MoveVerificationCard />
      {!isOffice && <PartnerMergeCard />}
      {!isOffice && <PartnerGradeCard />}
      {!isOffice && <BlitzApprovalCard />}
      {!isOffice && <FillApprovalCard />}
      <BoostCard />
      <LeftoverCard />

      <section data-testid="portfolio-strip">
        <div className="eyebrow mb-2">Portfolio · Holding Co</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="p-3.5" data-testid="portfolio-card" style={{ borderColor: "var(--accent-030)" }}>
            <div className="flex items-center justify-between">
              <span className="font-semibold">{identity.name}</span>
              <span className="eyebrow text-accent-gold">{coverage.hasData ? `${coverage.coveragePct}% cov` : "—"}</span>
            </div>
            <div className="mono mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
              <span>Cash wk <b style={{ color: "var(--text-body)" }}>{money.cashWkCents > 0 ? usdK(money.cashWkCents) : "—"}</b></span>
              <span>AR <b style={{ color: "var(--text-body)" }}>{money.arTotalCents > 0 ? usdK(money.arTotalCents) : "—"}</b></span>
              <span style={{ color: "var(--accent-gold)" }}>{coverage.openExceptions} exceptions</span>
              {valuationLine && (
                <Link href="/money/owners-room" data-testid="portfolio-valuation">
                  Value <b style={{ color: "var(--text-body)" }}>{valuationLine}</b>
                </Link>
              )}
            </div>
          </Card>
          {/* Illustrative — the multi-tenant vision. No numbers: onboarding a tenant lights its map. */}
          <Card className="p-3.5" data-testid="portfolio-placeholder">
            <div className="flex items-center justify-between" style={{ color: "var(--text-faint)" }}>
              <span className="font-semibold">Acquisition #2</span><span className="eyebrow">Q4 target</span>
            </div>
            <p className="mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>Onboard = point a phone # + import the spine → this coverage map lights up.</p>
          </Card>
          <div className={isOffice ? "hidden" : "hidden lg:block"}>
            <LockedTile
              phase="Phase 24"
              title="M&A Machine"
              tease="A roll-up engine that finds, diligences and onboards roofing companies onto this console — each acquisition lights up its own coverage map."
              thesis="Phase 24 makes acquisition itself a workflow: source targets, run financial + ops diligence from their data, and onboard onto Savvy by pointing a phone number and importing the spine. The portfolio strip above is the endgame — one console, many companies, zero new software per acquisition."
            />
          </div>
        </div>
      </section>

      {/* TODAY HEADER */}
      <section>
        <div className="eyebrow">Today · {today}</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight" data-testid="decision-headline">
          {decisions.length === 0 ? "Nothing needs you" : `${decisions.length} decision${decisions.length === 1 ? "" : "s"} need you`}
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
          {decisions.length === 0 ? (
            "Everything is running in the background — the product working."
          ) : (
            <>Estimated <b style={{ color: "var(--accent-gold)" }}>{estMinutes} minute{estMinutes === 1 ? "" : "s"}</b> of your attention · everything else is running in the background</>
          )}
        </p>
        <div className="mt-2">
          <Odometer view={odometer} />
        </div>
      </section>

      {/* DECISION QUEUE */}
      <section className="space-y-3" data-testid="decision-queue">
        {decisions.length === 0 ? (
          <Card className="p-6 text-center" data-testid="decision-empty">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>Nothing needs you right now. The agents have it.</p>
          </Card>
        ) : (
          decisions.map((d, i) => (
            <Card key={`${d.kind}-${i}`} className="p-4" data-testid="decision-card" data-severity={d.severity}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                      style={{
                        background: d.severity === "high" ? "var(--status-error-010, rgba(229,86,75,0.12))" : "var(--accent-010)",
                        color: d.severity === "high" ? "var(--status-error)" : "var(--accent-gold)",
                      }}
                    >
                      {KIND_LABEL[d.kind] ?? d.kind}
                    </span>
                    <span className="font-semibold">{d.title}</span>
                  </div>
                </div>
                <div className="mono shrink-0 text-right text-[11px]" style={{ color: "var(--text-faint)" }}>{ago(d.occurredAt)}</div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-4">
                <span className="mono text-[12px]" style={{ color: "var(--text-muted)" }}>{d.detail}</span>
                <Link
                  href={d.href}
                  className="mono shrink-0 rounded-md px-3 py-1.5 text-[12px] font-semibold"
                  style={{ background: "var(--accent-gold)", color: "#1b1408" }}
                  data-testid="decision-action"
                >
                  Resolve →
                </Link>
              </div>
              {d.checkKey === "comms.deliverability" && (
                <ol className="mono mt-3 space-y-1.5 border-t pt-3 text-[11px]">
                  {A2P_REGISTRATION_STEPS.map((step, i) => (
                    <li key={step.title} className="flex gap-2">
                      <span className="shrink-0 font-semibold" style={{ color: "var(--accent-gold)" }}>{i + 1}.</span>
                      <div>
                        <b style={{ color: "var(--text-body)", fontWeight: 500 }}>{step.title}</b>
                        <span style={{ color: "var(--text-muted)" }}> — {step.detail}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          ))
        )}
      </section>

      {/* DIGEST + MONEY */}
      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-4" data-testid="digest-panel">
          <div className="eyebrow mb-2 flex items-center justify-between">
            <span>While you were out · last 24h · {digest.totalActions} agent action{digest.totalActions === 1 ? "" : "s"}</span>
            <Link href="/activity" className="underline" style={{ color: "var(--accent-deep)" }} data-testid="today-activity-link">
              view live feed →
            </Link>
          </div>
          {digest.perAgent.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-faint)" }}>No agent activity in the last 24 hours.</p>
          ) : (
            <ul className="space-y-1.5">
              {digest.perAgent.map((a) => (
                <li key={a.agent} className="flex items-baseline gap-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  <span className="mono w-8 shrink-0 text-right text-accent-gold">{a.total}</span>
                  <span>
                    <b style={{ color: "var(--text-body)", fontWeight: 500 }}>{a.label}</b> actions
                    {a.error > 0 ? <span style={{ color: "var(--status-error)" }}> · {a.error} error{a.error === 1 ? "" : "s"}</span> : null}
                    {a.skipped > 0 ? <span style={{ color: "var(--text-faint)" }}> · {a.skipped} skipped</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4" data-testid="money-strip">
          <div className="eyebrow mb-3">Money</div>
          <div className="grid grid-cols-2 gap-3">
            <Kpi label="Cash · wk" value={money.cashWkCents > 0 ? usdK(money.cashWkCents) : "—"} tip={money.cashWkCents > 0 ? undefined : "No payments recorded in the last 7 days"} />
            <Kpi label="AR > 45d" value={money.arOver45Cents > 0 ? usdK(money.arOver45Cents) : "—"} sub={money.arOver45Count > 0 ? `${money.arOver45Count} invoice${money.arOver45Count === 1 ? "" : "s"}` : undefined} bad={money.arOver45Cents > 0} />
            <Kpi label="GM · MTD" value="—" tip="Gross-margin actuals land with contract cell 14" />
            <Kpi label="Founder-min / job" value={money.founderMinPerJob != null ? `${money.founderMinPerJob}m` : "—"} tip={money.founderMinPerJob == null ? "Populates after the first nightly rollup" : undefined} />
          </div>
        </Card>
      </section>

      {/* COVERAGE MAP */}
      <CoverageMap rollup={rollup} />
    </div>
  );
}

function Kpi({ label, value, sub, tip, bad }: { label: string; value: string; sub?: string; tip?: string; bad?: boolean }) {
  return (
    <div title={tip}>
      <div className="eyebrow">{label}</div>
      <div className="mono mt-0.5 text-lg font-semibold" style={{ color: value === "—" ? "var(--text-faint)" : "var(--text-primary)" }}>{value}</div>
      {sub ? <div className="mono text-[10px]" style={{ color: bad ? "var(--status-error)" : "var(--text-faint)" }}>{sub}</div> : null}
    </div>
  );
}
