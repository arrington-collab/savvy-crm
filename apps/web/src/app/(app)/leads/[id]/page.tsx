import { notFound } from "next/navigation";
import { listLeadDocuments, getDocumentParseSummaries, getScoringSettings } from "@savvy/db";
import { getLeadDetail, getLeadArtifactsForLead } from "@/lib/leads-queries";
import { listUsers } from "@/lib/scheduling-queries";
import { getTenantId } from "@/lib/tenant";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { Card } from "@/components/ui/card";
import { ago } from "@/lib/format";
import { resolveAgent } from "@/lib/agents";
import { LeadActions } from "@/components/leads/LeadActions";
import { Breadcrumb } from "@/components/cockpit/Breadcrumb";
import { LeadEnrichmentCard } from "@/components/LeadEnrichmentCard";
import { RoofTypeEditor } from "./RoofTypeEditor";
import { RoofReplacementEditor } from "./RoofReplacementEditor";
import { LeadNotes } from "./LeadNotes";
import { StormCertSection } from "@/components/leads/StormCertSection";
import { PropertyMap } from "@/components/PropertyMap";
import { LogContactButton } from "@/components/leads/LogContactButton";
import { LeadArtifactsSections } from "./LeadArtifacts";
import { MessageBody } from "./MessageBody";
import { LeadDocsCard } from "./LeadDocsCard";
import { TimelineDocItem } from "./TimelineDocItem";
import { buildLeadTimelineFeed, parseLeadsListReturn, parseScoringConfig, scoreBandLegend, heartbeatState, SHOWCASE } from "@savvy/core";
import { ScoreScaleTooltip } from "./ScoreScaleTooltip";
import { CardInflight } from "@/components/inflight/CardInflight";
import { Heartbeat } from "@/components/heartbeat/Heartbeat";
import { lastTouchForLeads } from "@/lib/heartbeat-queries";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  const backHref = parseLeadsListReturn(from);
  const tenantId = await getTenantId();
  const [detail, users, artifacts, documents, scoringSettings] = await Promise.all([
    getLeadDetail(id),
    listUsers(),
    getLeadArtifactsForLead(id),
    listLeadDocuments({ tenantId, leadId: id }),
    getScoringSettings(tenantId),
  ]);
  if (!detail) notFound();

  const leadTouch = await lastTouchForLeads([id]);
  const hb = heartbeatState(leadTouch.get(id) ?? null, new Date(detail.createdAt), new Date(), SHOWCASE.COLD_DAYS);

  const bandLegend = scoreBandLegend(parseScoringConfig(scoringSettings));

  const parseSummaries = await getDocumentParseSummaries({
    tenantId,
    documentIds: documents
      .filter((d) => d.kind === "insurance_estimate" || d.kind === "measurement_report")
      .map((d) => d.id),
  });

  const qualifier = resolveAgent({ agent: "comms", taskKey: "lead.qualify" });

  const feed = buildLeadTimelineFeed({
    communications: detail.communications,
    notes: detail.notes,
    documents,
  });

  return (
    <div className="space-y-6" data-testid="lead-detail">
      <div className="flex items-center justify-between">
        <Link href={backHref} data-testid="back-to-leads">
          <Button variant="secondary" size="sm">← Back to Leads</Button>
        </Link>
        <Breadcrumb segments={[{ label: "Leads", href: backHref }, { label: detail.customerName ?? "Lead" }]} />
      </div>
      <PageHeader
        eyebrow="Lead"
        title={detail.customerName ?? "Lead"}
        right={
          <div className="flex items-center gap-1.5">
            <StatusBadge status={detail.status} />
            <CardInflight kind="lead" id={id} />
            <Heartbeat kind="lead" id={id} state={hb} />
          </div>
        }
      />

      {/* 1 — Contact / address + map (+ owner) */}
      <div className="grid gap-4 md:grid-cols-3" data-section="contact">
        <Card className="p-4 md:col-span-2">
          <div className="eyebrow mb-1">Contact</div>
          <p className="text-sm" style={{ color: "var(--text-body)" }}>{detail.address ?? "—"}</p>
          <p className="mono mt-1 text-xs" style={{ color: "var(--text-muted)" }} data-testid="lead-phone">{detail.phone ?? "no phone"}</p>
          {detail.email && (
            <p className="mono mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
              <a href={`mailto:${detail.email}`} data-testid="lead-email" className="underline underline-offset-2">
                {detail.email}
              </a>
            </p>
          )}
          <PropertyMap
            address={detail.address}
            lat={detail.lat}
            lng={detail.lng}
            className="mt-3 block"
          />
          <div className="mt-3">
            <LogContactButton
              leadId={detail.id}
              firstRepContactAt={detail.firstRepContactAt}
            />
          </div>
        </Card>
        <Card className="p-4">
          <div className="eyebrow mb-1">Owner</div>
          <p className="text-sm" style={{ color: "var(--text-body)" }} data-testid="lead-owner">
            {detail.ownerName ?? "Unassigned"}
          </p>
        </Card>
      </div>

      {/* 2 — Score */}
      <Card className="p-4" data-section="score">
        <div className="eyebrow mb-1">AI score · ATLAS</div>
        <div className="flex items-center gap-2">
          <div className="text-3xl font-semibold" style={{ color: "var(--text-primary)" }} data-testid="lead-score">
            {detail.score ?? "—"}
          </div>
          {detail.scoreBand && (
            <span
              data-testid="lead-band"
              className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize"
              style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}
            >
              {detail.scoreBand}
            </span>
          )}
          <ScoreScaleTooltip legend={bandLegend} />
        </div>
        <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
          {detail.scoreReason ?? "Not yet qualified."}
        </p>
        {Array.isArray(detail.scoreFeatures?.reasons) && (
          <ul className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            {detail.scoreFeatures.reasons.map((r, i) => (
              <li key={i}>• {r}</li>
            ))}
          </ul>
        )}
      </Card>

      <LeadActions leadId={detail.id} status={detail.status} users={users} ownerId={detail.assignedUserId} />

      {/* 3 — Roof: types ×2, effective age + replacement, enrichment, storm cert */}
      <div className="space-y-4" data-section="roof">
        <RoofTypeEditor leadId={detail.id} propertyId={detail.propertyId} current={detail.roofType} secondary={detail.roofTypeSecondary} />
        <RoofReplacementEditor leadId={detail.id} propertyId={detail.propertyId} at={detail.lastRoofReplacementAt} source={detail.lastRoofReplacementSource} />
        <LeadEnrichmentCard
          scoreFeatures={detail.scoreFeatures}
          yearBuilt={detail.yearBuilt}
          roofType={detail.roofType}
          county={detail.county}
          installRecommendation={detail.installRecommendation}
        />
        <Card className="p-4">
          <div className="eyebrow mb-3">Storm Certification</div>
          <StormCertSection
            stormCertStatus={detail.stormCertStatus}
            stormCheckedAt={detail.stormCheckedAt}
            stormCertDocumentId={detail.stormCertDocumentId}
            leadId={detail.id}
          />
        </Card>
      </div>

      {/* 4 & 5 — Measurement + Estimate (each carries its own data-section) */}
      <LeadArtifactsSections artifacts={artifacts} leadId={detail.id} hasProperty={Boolean(detail.propertyId)} />

      {/* 6 — Documents */}
      <div data-section="documents">
        <LeadDocsCard leadId={detail.id} documents={documents} parseSummaries={parseSummaries} />
      </div>

      {/* 7 — Source + notes */}
      <div className="space-y-4" data-section="source">
        <Card className="p-4">
          <div className="eyebrow mb-1">Source</div>
          <p className="mono text-sm" style={{ color: "var(--text-body)" }} data-testid="lead-source-value">
            {detail.source ?? "—"}
          </p>
        </Card>
        <LeadNotes leadId={detail.id} />
      </div>

      {/* 8 — Communications timeline */}
      <Card className="p-4" data-section="comms">
        <div className="eyebrow mb-3">Communications</div>
        {feed.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No communications yet.</p>
        ) : (
          <ul className="space-y-3">
            {feed.map((item) =>
              item.kind === "note" ? (
                <li key={`note-${item.id}`} className="flex items-start gap-2 text-sm">
                  <span
                    className="mt-0.5 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}
                  >
                    Note
                  </span>
                  <div>
                    <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                      {item.authorName ? `${item.authorName} · ` : ""}
                      {ago(item.at)}
                    </div>
                    <p className="text-sm" style={{ color: "var(--text-body)" }}>{item.body}</p>
                  </div>
                </li>
              ) : item.kind === "document" ? (
                <TimelineDocItem
                  key={`doc-${item.id}`}
                  id={item.id}
                  filename={item.filename}
                  mime={item.mime}
                  uploaderName={item.uploaderName}
                  at={item.at}
                  docKind={item.docKind}
                />
              ) : (
                <li key={`comm-${item.id}`} className="flex items-start gap-2 text-sm">
                  <AgentAvatar persona={qualifier.persona} size="sm" />
                  <div>
                    <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                      {item.channel} · {item.direction} · {ago(item.at)}
                    </div>
                    <MessageBody body={item.body} />
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
      </Card>
    </div>
  );
}
