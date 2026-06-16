import {
  withTenant,
  job,
  customer,
  property,
  jobTask,
  communication,
  jobStageEvent,
  auditLog,
  document,
  tenant,
  eq,
  and,
  desc,
  asc,
  sql,
} from "@savvy/db";
import Link from "next/link";
import { parseProductionConfig } from "@savvy/core";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getTenantId } from "@/lib/tenant";
import { JobTabs } from "./tabs";
import { EstimateActions } from "./EstimateActions";
import {
  listEstimatesForJob,
  getLatestMeasurementForJob,
} from "@/lib/estimate-queries";

export const dynamic = "force-dynamic";

function daysInStage(stageEnteredAt: Date | null): number {
  if (!stageEnteredAt) return 0;
  return Math.floor((Date.now() - stageEnteredAt.getTime()) / 86_400_000);
}

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tenantId = await getTenantId();

  const data = await withTenant(tenantId, async (tx) => {
    const [jobRow] = await tx
      .select({
        id: job.id,
        type: job.type,
        stage: job.stage,
        valueEstimate: job.valueEstimate,
        stageEnteredAt: job.stageEnteredAt,
        propertyId: job.propertyId,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        address: property.address,
      })
      .from(job)
      .leftJoin(customer, eq(customer.id, job.customerId))
      .leftJoin(property, eq(property.id, job.propertyId))
      .where(eq(job.id, id))
      .limit(1);

    if (!jobRow) return null;

    const taskRows = await tx
      .select({
        id: jobTask.id,
        title: jobTask.title,
        phase: jobTask.phase,
        automationLevel: jobTask.automationLevel,
        status: jobTask.status,
        dueAt: jobTask.dueAt,
        ownerAgent: jobTask.ownerAgent,
      })
      .from(jobTask)
      .where(eq(jobTask.jobId, id))
      .orderBy(asc(sql`(${jobTask.payload}->>'num')::int`));

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

    const audits = await tx
      .select({
        id: auditLog.id,
        action: auditLog.action,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "job"), eq(auditLog.entityId, id)))
      .orderBy(desc(auditLog.createdAt));

    const docRows = await tx
      .select({
        id: document.id,
        kind: document.kind,
        label: document.label,
        filename: document.filename,
        mime: document.mime,
        createdAt: document.createdAt,
      })
      .from(document)
      .where(eq(document.jobId, id))
      .orderBy(desc(document.createdAt));

    const [tenantRow] = await tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, tenantId));

    return { jobRow, taskRows, commRows, stageEvents, audits, docRows, tenantRow };
  });

  if (!data) {
    return (
      <div data-testid="job-detail" className="py-12 text-center">
        <p className="text-muted-foreground">Job not found</p>
      </div>
    );
  }

  const { jobRow, taskRows, commRows, stageEvents, audits, docRows, tenantRow } = data;

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
      text: a.action,
    })),
  ].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));

  // Group tasks by phase, preserving num order within each phase.
  const tasksByPhaseMap = new Map<
    string,
    {
      id: string;
      title: string;
      phase: string;
      automationLevel: string;
      status: string;
      dueAt: string | null;
      ownerAgent: string | null;
    }[]
  >();
  for (const t of taskRows) {
    const phase = t.phase ?? "Other";
    if (!tasksByPhaseMap.has(phase)) tasksByPhaseMap.set(phase, []);
    tasksByPhaseMap.get(phase)!.push({
      id: t.id,
      title: t.title,
      phase,
      automationLevel: t.automationLevel ?? "manual",
      status: t.status,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      ownerAgent: t.ownerAgent ?? null,
    });
  }
  const tasksByPhase = Array.from(tasksByPhaseMap.entries()).map(
    ([phase, tasks]) => ({ phase, tasks }),
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
    createdAt: d.createdAt.toISOString(),
  }));

  // Parse required-photo config from tenant settings and pick the job's type
  const productionConfig = parseProductionConfig(
    (tenantRow?.settings as { production?: unknown } | undefined)?.production,
  );
  const requiredPhotos =
    productionConfig.requiredPhotos[jobRow.type as keyof typeof productionConfig.requiredPhotos] ??
    [];

  const value = (jobRow.valueEstimate ?? 0) / 100;

  // Fetch estimate and measurement data in parallel (after confirming job exists).
  const [estimates, measurement] = await Promise.all([
    listEstimatesForJob(id),
    getLatestMeasurementForJob(id),
  ]);

  // Serialize measurement areas for client component (jsonb -> plain object).
  const measurementForClient = measurement
    ? {
        id: measurement.id,
        areas: (measurement.areas as Record<string, unknown>) ?? {},
        pitch: measurement.pitch ?? null,
      }
    : null;

  // Status badge color map for estimates.
  const ESTIMATE_STATUS_COLORS: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    sent: "bg-blue-100 text-blue-800",
    accepted: "bg-green-100 text-green-800",
  };

  function fmtUsd(cents: number | null | undefined): string {
    return ((cents ?? 0) / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
  }

  return (
    <div data-testid="job-detail" className="space-y-6">
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
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Badge variant="outline" className="capitalize">
                {jobRow.type}
              </Badge>
              <Badge variant="secondary" className="capitalize">
                {jobRow.stage}
              </Badge>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold">
              ${value.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">
              {daysInStage(jobRow.stageEnteredAt)}d in stage
            </div>
          </div>
        </div>
      </Card>

      <JobTabs
        tasksByPhase={tasksByPhase}
        timeline={timeline}
        comms={comms}
        docs={docs}
        requiredPhotos={requiredPhotos}
        jobId={jobRow.id}
      />

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
                const statusCls =
                  ESTIMATE_STATUS_COLORS[statusLabel] ??
                  "bg-muted text-muted-foreground";
                return (
                  <Link
                    key={est.id}
                    href={`/jobs/${id}/estimates/${est.id}`}
                    className="block"
                    data-testid="estimate-row"
                  >
                    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50 transition-colors">
                      <span className="text-muted-foreground capitalize">
                        {est.source} estimate
                      </span>
                      <div className="flex items-center gap-3">
                        <span className="font-medium">{fmtUsd(est.total)}</span>
                        <span
                          className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${statusCls}`}
                        >
                          {statusLabel}
                        </span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          {estimates.length === 0 && (
            <p className="text-sm text-muted-foreground">No estimates yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
