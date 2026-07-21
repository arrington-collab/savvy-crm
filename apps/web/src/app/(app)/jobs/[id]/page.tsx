import {
  withTenant,
  job,
  customer,
  property,
  jobChecklistItem,
  communication,
  jobStageEvent,
  auditLog,
  document,
  esignRequest,
  tenant,
  referralPayment,
  user,
  eq,
  and,
  or,
  inArray,
  desc,
  asc,
  sql,
  getClaimForJob,
  getAdjusterAppointmentForJob,
  getJobLedger,
  DEPRECIATION_APPROVAL_TASK_KEY,
  REFERRAL_FEE_APPROVAL_TASK_KEY,
  listFlaggedPhotosForJob,
  getDocumentParseSummaries,
} from "@savvy/db";
import { getJobCheckins } from "@/lib/crew-queries";
import Link from "next/link";
import { parseProductionConfig, computeJobMargin, summarizeJobAutomation, recoverableDepreciationCents, heartbeatState, SHOWCASE } from "@savvy/core";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getTenantId } from "@/lib/tenant";
import { JobTabs } from "./tabs";
import { FocusOnMount } from "./FocusOnMount";
import { JobLedgerCard } from "./JobLedgerCard";
import { JobLedgerAskSage } from "./JobLedgerAskSage";
import { AutomationModule } from "./AutomationModule";
import { EstimateActions } from "./EstimateActions";
import {
  listEstimatesForJob,
  getLatestMeasurementForJob,
} from "@/lib/estimate-queries";
import { listChangeOrdersForJob } from "@/lib/change-order-queries";
import { ChangeOrdersSection } from "./ChangeOrdersSection";
import { listMaterialOrdersForJob, getJobInstallDateForJob } from "@/lib/material-queries";
import { MaterialsPanel, type MaterialsPanelOrder } from "./MaterialsPanel";
import { ClaimPanel, type ClaimPanelTask } from "./ClaimPanel";
import { materialDeliveryFlag } from "@savvy/core";
import { fmtUsd } from "@/lib/format";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { resolveAgentForStage, personaLine, PERSONAS } from "@/lib/agents";
import { Breadcrumb } from "@/components/cockpit/Breadcrumb";
import { PropertyMap } from "@/components/PropertyMap";
import { FlaggedPhotosPanel } from "./FlaggedPhotosPanel";
import { SupplierInvoicesPanel } from "./SupplierInvoicesPanel";
import { ReferralFeeApproval } from "./ReferralFeeApproval";
import { CardInflight } from "@/components/inflight/CardInflight";
import { PhaseProgressCard } from "@/components/production/PhaseProgressCard";
import { Heartbeat } from "@/components/heartbeat/Heartbeat";
import { lastTouchForJobs } from "@/lib/heartbeat-queries";

export const dynamic = "force-dynamic";

function daysInStage(stageEnteredAt: Date | null): number {
  if (!stageEnteredAt) return 0;
  return Math.floor((Date.now() - stageEnteredAt.getTime()) / 86_400_000);
}

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ focus?: string }>;
}) {
  const { id } = await params;
  // A Today decision-card deep-links here with ?focus=<surface> (tasks/docs/
  // materials/margin) so we open the right tab and ring the exact panel.
  const { focus } = await searchParams;
  const tenantId = await getTenantId();

  const data = await withTenant(tenantId, async (tx) => {
    const [jobRow] = await tx
      .select({
        id: job.id,
        type: job.type,
        stage: job.stage,
        valueEstimate: job.valueEstimate,
        valueFinal: job.valueFinal,
        costCents: job.costCents,
        stageEnteredAt: job.stageEnteredAt,
        createdAt: job.createdAt,
        rescissionHoldUntil: job.rescissionHoldUntil,
        propertyId: job.propertyId,
        companycamProjectId: job.companycamProjectId,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        address: property.address,
        lat: property.lat,
        lng: property.lng,
      })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(eq(job.id, id))
      .limit(1);

    if (!jobRow) return null;

    const taskRows = await tx
      .select({
        id: jobChecklistItem.id,
        key: jobChecklistItem.key,
        title: jobChecklistItem.title,
        phase: jobChecklistItem.phase,
        automationLevel: jobChecklistItem.automationLevel,
        status: jobChecklistItem.status,
        dueAt: jobChecklistItem.dueAt,
        ownerAgent: jobChecklistItem.ownerAgent,
        payload: jobChecklistItem.payload,
      })
      .from(jobChecklistItem)
      .where(eq(jobChecklistItem.jobId, id))
      .orderBy(asc(sql`(${jobChecklistItem.payload}->>'num')::int`));

    const commRows = await tx
      .select({
        id: communication.id,
        channel: communication.channel,
        direction: communication.direction,
        body: communication.body,
        createdAt: communication.createdAt,
      })
      .from(communication)
      .where(eq(communication.jobId, id))
      .orderBy(desc(communication.createdAt))
      .limit(50);

    const stageEvents = await tx
      .select({
        id: jobStageEvent.id,
        fromStage: jobStageEvent.fromStage,
        toStage: jobStageEvent.toStage,
        enteredAt: jobStageEvent.enteredAt,
        note: jobStageEvent.note,
      })
      .from(jobStageEvent)
      .where(eq(jobStageEvent.jobId, id))
      .orderBy(desc(jobStageEvent.enteredAt));

    // This job's document ids (as text) — used to also surface document-scoped
    // audits (e.g. photo_qc_kept) in the job Timeline. entityId is text, so compare
    // against string ids, not a uuid subquery (avoids a text=uuid Postgres error).
    const jobDocIds = (
      await tx.select({ id: document.id }).from(document).where(eq(document.jobId, id))
    ).map((r) => r.id);

    const auditWhere =
      jobDocIds.length > 0
        ? or(
            and(eq(auditLog.entityType, "job"), eq(auditLog.entityId, id)),
            and(eq(auditLog.entityType, "document"), inArray(auditLog.entityId, jobDocIds)),
          )
        : and(eq(auditLog.entityType, "job"), eq(auditLog.entityId, id));

    const audits = await tx
      .select({
        id: auditLog.id,
        action: auditLog.action,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(auditWhere)
      .orderBy(desc(auditLog.createdAt));

    const docRows = await tx
      .select({
        id: document.id,
        kind: document.kind,
        label: document.label,
        filename: document.filename,
        mime: document.mime,
        source: document.source,
        externalUrl: document.externalUrl,
        parseStatus: document.parseStatus,
        uploaderName: user.name,
        createdAt: document.createdAt,
      })
      .from(document)
      .leftJoin(user, eq(document.uploadedByUserId, user.id))
      .where(eq(document.jobId, id))
      .orderBy(desc(document.createdAt));

    const esignRows = await tx
      .select({
        id: esignRequest.id,
        docType: esignRequest.docType,
        status: esignRequest.status,
        signingUrl: esignRequest.signingUrl,
        documentId: esignRequest.documentId,
      })
      .from(esignRequest)
      .where(eq(esignRequest.jobId, id))
      .orderBy(desc(esignRequest.createdAt));

    const [tenantRow] = await tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, tenantId));

    const [referralPaymentRow] = await tx
      .select({ amountCents: referralPayment.amountCents, status: referralPayment.status })
      .from(referralPayment)
      .where(eq(referralPayment.jobId, id));

    return { jobRow, taskRows, commRows, stageEvents, audits, docRows, esignRows, tenantRow, referralPaymentRow };
  });

  if (!data) {
    return (
      <div data-testid="job-detail" className="py-12 text-center">
        <p className="text-muted-foreground">Job not found</p>
      </div>
    );
  }

  const { jobRow, taskRows, commRows, stageEvents, audits, docRows, esignRows, tenantRow, referralPaymentRow } = data;

  const jobTouch = await lastTouchForJobs([id]);
  const hb = heartbeatState(jobTouch.get(id) ?? null, new Date(jobRow.createdAt), new Date(), SHOWCASE.COLD_DAYS);

  // The Job Ledger — registry tasks instantiated for this job + evidence + health.
  const ledger = await getJobLedger(tenantId, id);

  // Build merged timeline (server-side), dates serialized to ISO strings.
  type TimelineItem = { kind: "stage" | "comm" | "audit"; at: string; text: string };
  const timeline: TimelineItem[] = [
    ...stageEvents.map((e) => ({
      kind: "stage" as const,
      at: e.enteredAt.toISOString(),
      text: e.fromStage
        ? `Moved ${e.fromStage} → ${e.toStage}`
        : `Entered ${e.toStage}`,
    })),
    ...commRows.map((c) => ({
      kind: "comm" as const,
      at: c.createdAt.toISOString(),
      text: `${c.direction} ${c.channel}${c.body ? `: ${c.body}` : ""}`,
    })),
    ...audits.map((a) => ({
      kind: "audit" as const,
      at: a.createdAt.toISOString(),
      text: a.action === "photo_qc_kept" ? "Kept flagged photo" : a.action,
    })),
  ].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));

  const automationSummary = summarizeJobAutomation(
    taskRows.map((t) => ({ ownerAgent: t.ownerAgent, automationLevel: t.automationLevel, status: t.status })),
  );

  const comms = commRows.map((c) => ({
    id: c.id,
    channel: c.channel,
    direction: c.direction,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
  }));

  // Serialize document dates to ISO strings for client props
  const docs = docRows.map((d) => ({
    id: d.id,
    kind: d.kind,
    label: d.label,
    filename: d.filename,
    mime: d.mime,
    source: d.source ?? null,
    externalUrl: d.externalUrl ?? null,
    parseStatus: d.parseStatus,
    uploaderName: d.uploaderName,
    createdAt: d.createdAt.toISOString(),
  }));

  const docParseSummaries = await getDocumentParseSummaries({
    tenantId,
    documentIds: docs
      .filter((d) => d.kind === "insurance_estimate" || d.kind === "measurement_report")
      .map((d) => d.id),
  });

  // Parse required-photo config from tenant settings and pick the job's type
  const productionConfig = parseProductionConfig(
    (tenantRow?.settings as { production?: unknown } | undefined)?.production,
  );
  const requiredPhotos =
    productionConfig.requiredPhotos[jobRow.type as keyof typeof productionConfig.requiredPhotos] ??
    [];

  const value = (jobRow.valueEstimate ?? 0) / 100;
  // Real-time margin: revenue (final or estimate) minus cost recorded so far.
  const margin = computeJobMargin({ revenueCents: jobRow.valueFinal ?? jobRow.valueEstimate, costCents: jobRow.costCents });
  const dollars = (cents: number) => `$${(cents / 100).toLocaleString()}`;

  // Fetch estimate, measurement, change orders, crew check-ins, material orders, and claim data in parallel.
  const [estimates, measurement, changeOrders, checkins, materialOrders, installDate, claimRow, adjusterAppt, flaggedPhotos] = await Promise.all([
    listEstimatesForJob(id),
    getLatestMeasurementForJob(id),
    listChangeOrdersForJob(id),
    getJobCheckins(tenantId, id),
    listMaterialOrdersForJob(id),
    getJobInstallDateForJob(id),
    jobRow.type === "insurance" ? getClaimForJob(tenantId, id) : Promise.resolve(null),
    jobRow.type === "insurance" ? getAdjusterAppointmentForJob(tenantId, id) : Promise.resolve(null),
    listFlaggedPhotosForJob(tenantId, id),
  ]);

  // Serialize checkin dates to ISO strings for client props.
  const checkinRows = checkins.map((c) => ({
    id: c.id,
    crewName: c.crewName,
    checkedInAt: c.checkedInAt.toISOString(),
    checkedOutAt: c.checkedOutAt ? c.checkedOutAt.toISOString() : null,
  }));

  // Serialize material orders + compute delivery flag server-side (no Date objects to client).
  const materialOrdersForClient: MaterialsPanelOrder[] = materialOrders.map((o) => ({
    id: o.id,
    status: o.status,
    subtotalCents: o.subtotalCents,
    costSubtotalCents: o.costSubtotalCents,
    neededByISO: o.neededByAt ? o.neededByAt.toISOString() : null,
    lines: o.lineItems.map((l) => ({ key: l.key, name: l.name, quantity: l.quantity, unit: l.unit, amountCents: l.amountCents })),
    flag: materialDeliveryFlag({ neededByAt: o.neededByAt ?? null, installAt: installDate }),
  }));

  // Serialize claim row for ClaimPanel (no Date objects to client).
  const claimForClient = claimRow
    ? {
        claimNumber: claimRow.claimNumber,
        carrierName: claimRow.carrierName,
        adjusterName: claimRow.adjusterName,
        adjusterPhone: claimRow.adjusterPhone,
        status: claimRow.status,
        acvCents: claimRow.acvCents,
        rcvCents: claimRow.rcvCents,
        deductibleCents: claimRow.deductibleCents,
        filedAtISO: claimRow.filedAt ? claimRow.filedAt.toISOString() : null,
      }
    : null;

  const adjusterApptForClient = adjusterAppt
    ? {
        startsAtISO: adjusterAppt.startsAt.toISOString(),
        endsAtISO: adjusterAppt.endsAt.toISOString(),
      }
    : null;

  const claimTasks: ClaimPanelTask[] = taskRows
    .filter((t) => t.phase === "Insurance Claim Management")
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));

  // Depreciation-recovery state (§G) for the ClaimPanel: recoverable amount + draft/send status.
  const depreciationApproval = taskRows.find((t) => t.key === DEPRECIATION_APPROVAL_TASK_KEY);
  const depreciationForClient = claimForClient
    ? {
        recoverableCents: recoverableDepreciationCents({ rcvCents: claimForClient.rcvCents, acvCents: claimForClient.acvCents }),
        draftInvoiceId: (depreciationApproval?.payload as { invoiceId?: string } | undefined)?.invoiceId ?? null,
        draftStatus: (depreciationApproval
          ? depreciationApproval.status === "done" ? "sent" : "pending_approval"
          : "none") as "none" | "pending_approval" | "sent",
      }
    : null;

  // Over-threshold referral-fee approval card (Task 5/10): surfaced as a one-tap approve.
  const referralApproval =
    referralPaymentRow?.status === "pending" ? taskRows.find((t) => t.key === REFERRAL_FEE_APPROVAL_TASK_KEY) : undefined;

  // Serialize measurement areas for client component (jsonb -> plain object).
  const measurementForClient = measurement
    ? {
        id: measurement.id,
        areas: (measurement.areas as Record<string, unknown>) ?? {},
        pitch: measurement.pitch ?? null,
      }
    : null;

  return (
    <div data-testid="job-detail" className="space-y-6">
      <FocusOnMount focus={focus} />
      <Breadcrumb segments={[{ label: "Jobs", href: "/jobs" }, { label: jobRow.customerName ?? "Job" }]} />
      {jobRow.rescissionHoldUntil && new Date(jobRow.rescissionHoldUntil) > new Date() && (
        <div
          className="rounded-md border p-3 text-sm"
          style={{ borderColor: "var(--border)", background: "var(--surface-muted)" }}
          data-testid="rescission-hold-banner"
        >
          <span className="font-medium">Production held</span> — rescission window. Materials &amp; crew scheduling release{" "}
          {new Date(jobRow.rescissionHoldUntil).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
        </div>
      )}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">
              {jobRow.customerName ?? "—"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {jobRow.address ?? "—"}
            </p>
            {(jobRow.customerEmail || jobRow.customerPhone) && (
              <p className="text-xs text-muted-foreground">
                {[jobRow.customerEmail, jobRow.customerPhone]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <PropertyMap
              address={jobRow.address}
              lat={jobRow.lat}
              lng={jobRow.lng}
              className="mt-3 block max-w-md"
            />
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Badge variant="outline" className="capitalize">
                {jobRow.type}
              </Badge>
              <Badge variant="secondary" className="capitalize">
                {jobRow.stage}
              </Badge>
              <AgentAvatar persona={resolveAgentForStage(jobRow.stage).persona} size="sm" />
              <CardInflight kind="job" id={id} />
              <Heartbeat kind="job" id={id} state={hb} />
            </div>
          </div>
          <div className="text-right">
            <div className="mono text-2xl font-semibold text-accent-gold">
              ${value.toLocaleString()}
            </div>
            <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
              {daysInStage(jobRow.stageEnteredAt)}d in stage
            </div>
          </div>
        </div>
      </Card>

      {referralApproval && referralPaymentRow && (
        <ReferralFeeApproval jobId={id} title={referralApproval.title} amountCents={referralPaymentRow.amountCents} />
      )}

      <Card id="focus-margin" data-testid="job-margin" className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="text-sm font-medium">Money &amp; margin</div>
          <div className="flex flex-wrap items-center gap-8">
            <div>
              <div className="text-xs text-muted-foreground">Revenue</div>
              <div className="mono text-lg font-semibold">{dollars(margin.revenueCents)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Cost{margin.costKnown ? "" : " (none recorded)"}</div>
              <div className="mono text-lg font-semibold">{dollars(margin.costCents)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Margin{margin.marginPct != null ? ` (${margin.marginPct}%)` : ""}</div>
              <div
                data-testid="job-margin-amount"
                className={`mono text-lg font-semibold ${margin.marginCents >= 0 ? "text-accent-gold" : "text-destructive"}`}
              >
                {dollars(margin.marginCents)}
              </div>
            </div>
          </div>
        </div>
        {!margin.costKnown ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Margin reflects costs recorded so far; it sharpens as materials and labor are tracked.
          </p>
        ) : null}
      </Card>

      {/* Production Pulse: live phase progress — evidence advances this, not buttons */}
      <PhaseProgressCard jobId={id} />

      <AutomationModule summary={automationSummary} />

      <FlaggedPhotosPanel jobId={id} documents={flaggedPhotos} />

      <div id="focus-tabs">
        <JobTabs
          ledgerRows={ledger}
          timeline={timeline}
          comms={comms}
          docs={docs}
          docParseSummaries={docParseSummaries}
          requiredPhotos={requiredPhotos}
          jobId={jobRow.id}
          companycamProjectId={jobRow.companycamProjectId ?? null}
          esignRequests={esignRows}
          customerEmail={jobRow.customerEmail ?? null}
          checkins={checkinRows}
          defaultTab={focus}
        />
      </div>

      {/* Job Ledger — the scoreboard proof surface for this job */}
      <JobLedgerAskSage jobId={jobRow.id} rows={ledger} />
      <JobLedgerCard rows={ledger} timeline={timeline} />

      {/* Estimates section */}
      <Card>
        <CardHeader>
          <CardTitle>Estimates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <EstimateActions
            jobId={id}
            propertyId={jobRow.propertyId}
            measurement={measurementForClient}
          />

          {estimates.length > 0 && (
            <div className="space-y-2">
              {estimates.map((est) => {
                const statusLabel = est.status ?? "draft";
                return (
                  <Link
                    key={est.id}
                    href={`/jobs/${id}/estimates/${est.id}`}
                    className="block"
                    data-testid="estimate-row"
                  >
                    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50 transition-colors">
                      <span className="capitalize" style={{ color: "var(--text-muted)" }}>
                        {est.source} estimate
                      </span>
                      <div className="flex items-center gap-3">
                        <span className="mono font-medium text-accent-gold">{fmtUsd(est.total)}</span>
                        <StatusBadge status={statusLabel} />
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          {estimates.length === 0 && (
            <p className="text-sm" style={{ color: "var(--text-faint)" }}>{personaLine(PERSONAS.VERA)}</p>
          )}
        </CardContent>
      </Card>

      {/* Materials section */}
      <Card id="focus-materials">
        <CardHeader><CardTitle>Materials</CardTitle></CardHeader>
        <CardContent>
          <MaterialsPanel jobId={id} orders={materialOrdersForClient} />
        </CardContent>
      </Card>

      {/* Supplier invoices section — actual billed amounts vs material-order snapshot */}
      <SupplierInvoicesPanel jobId={id} />

      {/* Insurance claim section (insurance jobs only) */}
      {jobRow.type === "insurance" && (
        <Card>
          <CardHeader><CardTitle>Insurance claim</CardTitle></CardHeader>
          <CardContent>
            <ClaimPanel
              jobId={id}
              claim={claimForClient}
              adjusterAppointment={adjusterApptForClient}
              tasks={claimTasks}
              depreciation={depreciationForClient}
            />
          </CardContent>
        </Card>
      )}

      {/* Change orders section */}
      <Card>
        <CardHeader><CardTitle>Change orders</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <ChangeOrdersSection jobId={id} />
          {changeOrders.length > 0 ? (
            <div className="space-y-2">
              {changeOrders.map((co) => (
                <Link key={co.id} href={`/jobs/${id}/change-orders/${co.id}`} className="block" data-testid="change-order-row">
                  <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50 transition-colors">
                    <span className="truncate" style={{ color: "var(--text-muted)" }}>{co.reason || "Change order"}</span>
                    <div className="flex items-center gap-3">
                      <span className="mono font-medium text-accent-gold">{fmtUsd(co.total ?? 0)}</span>
                      <StatusBadge status={co.status} />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm" style={{ color: "var(--text-faint)" }}>{personaLine(PERSONAS.VERA, 2)}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
