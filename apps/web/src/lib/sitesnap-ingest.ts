import { resolveTenantByIngestKey, resolvePhotoJob, recordSiteSnapPhoto, getInspectionScope, ingestInspectionMedia, ingestProductionMedia, setPhotoCustomerSafe } from "@savvy/db";
import type { StorageGateway } from "@savvy/integrations";

export type IngestBody = {
  address: string; category: string; imageUrl: string; externalPhotoId: string;
  // Roof Record zone-first capture (all optional — plain job-site photos unchanged).
  // The zone comes from the capture flow's SELECTED section; GPS is a sanity
  // check only and is never used to place a photo on a zone.
  inspectionId?: string;
  zoneKey?: string;
  zoneLabel?: string;
  zoneKind?: string;
  checklistItemKey?: string;
  capturedAtMs?: number;
  gps?: { lat: number; lng: number };
  note?: string;
  // Production Pulse phase-first capture (BloomCam production mode): the crew
  // selects the job + phase; every photo carries the phase context. Unknown
  // phase keys are HELD for triage server-side — never bounced, never dropped.
  phaseKey?: string;
  shot?: string;
  crewMemberName?: string;
  // Crew intent: this shot is fit for the homeowner. Gate 1 of the double gate
  // (QC-passed is gate 2) — a photo reaches the homeowner only past BOTH.
  customerSafe?: boolean;
};
export type IngestDeps = {
  storage: StorageGateway;
  fetchBytes: (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;
  emit: (jobId: string | null, documentId: string, tenantId: string) => Promise<void>;
  emitInspectionMedia?: (info: { tenantId: string; inspectionId: string; leadId: string | null; zoneKey: string; documentId: string }) => Promise<void>;
  emitProductionMedia?: (info: { tenantId: string; jobId: string; phaseKey: string; documentId: string; phaseStatus: string; justCompleted: boolean }) => Promise<void>;
};

// BloomCam's live pushToSavvy() sends the Roof Record fields snake_case
// ("per spec") while this module reads camelCase — found 2026-07-16 when the
// mismatch silently degraded zone-first photos to plain job photos. Accept
// BOTH casings forever: the field app's outbox may replay old payloads.
function normalizeIngestBody(raw: IngestBody): IngestBody {
  const r = raw as IngestBody & {
    inspection_id?: string; zone_key?: string; zone_label?: string; zone_kind?: string;
    checklist_item_key?: string; captured_at?: number; external_photo_id?: string; image_url?: string;
  };
  return {
    ...raw,
    imageUrl: raw.imageUrl ?? r.image_url,
    externalPhotoId: raw.externalPhotoId ?? r.external_photo_id,
    inspectionId: raw.inspectionId ?? r.inspection_id,
    zoneKey: raw.zoneKey ?? r.zone_key,
    zoneLabel: raw.zoneLabel ?? r.zone_label,
    zoneKind: raw.zoneKind ?? r.zone_kind,
    checklistItemKey: raw.checklistItemKey ?? r.checklist_item_key,
    capturedAtMs: raw.capturedAtMs ?? r.captured_at,
  };
}

export async function ingestSiteSnapPhoto(rawBody: IngestBody, key: string, deps: IngestDeps): Promise<{ status: number; body: unknown }> {
  const body = normalizeIngestBody(rawBody);
  const t = await resolveTenantByIngestKey(key);
  if (!t) return { status: 401, body: { error: "unauthorized" } };

  let img: { bytes: Uint8Array; mime: string };
  try { img = await deps.fetchBytes(body.imageUrl); }
  catch { return { status: 502, body: { error: "image_fetch_failed" } }; }

  // A bad inspection id is not retryable — keep the photo either way and report
  // the link outcome, so BloomCam's outbox never bounces media on our account.
  const wantsInspection = Boolean(body.inspectionId && body.zoneKey);
  const scope = wantsInspection
    ? await getInspectionScope({ tenantId: t.tenantId, inspectionId: body.inspectionId! })
    : null;

  const match = await resolvePhotoJob({ tenantId: t.tenantId, address: body.address });
  const r2Key = `sitesnap/${t.tenantId}/${body.externalPhotoId}`;
  await deps.storage.putObject({ key: r2Key, bytes: img.bytes, contentType: img.mime });

  const rec = await recordSiteSnapPhoto({
    tenantId: t.tenantId, jobId: match?.jobId ?? null, category: body.category,
    r2Key, captureAddress: body.address, sitesnapPhotoId: body.externalPhotoId,
    leadId: scope?.leadId ?? null,
  });

  let inspectionLinked = false;
  if (wantsInspection && scope) {
    const link = await ingestInspectionMedia({
      tenantId: t.tenantId,
      inspectionId: body.inspectionId!,
      zoneKey: body.zoneKey!,
      zoneLabel: body.zoneLabel ?? body.zoneKey!,
      zoneKind: body.zoneKind,
      documentId: rec.documentId,
      checklistItemKey: body.checklistItemKey ?? null,
      capturedAt: body.capturedAtMs ? new Date(body.capturedAtMs) : null,
      gps: body.gps ?? null,
      note: body.note ?? null,
    });
    inspectionLinked = !("error" in link);
  }

  if (rec.created) {
    // Fail-soft: the row is committed; an emit hiccup must not fail the webhook.
    try { await deps.emit(match?.jobId ?? null, rec.documentId, t.tenantId); } catch { /* noop */ }
    if (inspectionLinked && deps.emitInspectionMedia) {
      try {
        await deps.emitInspectionMedia({
          tenantId: t.tenantId, inspectionId: body.inspectionId!, leadId: scope?.leadId ?? null,
          zoneKey: body.zoneKey!, documentId: rec.documentId,
        });
      } catch { /* noop */ }
    }
  }
  if (body.customerSafe && rec.created) {
    await setPhotoCustomerSafe({ tenantId: t.tenantId, documentId: rec.documentId, safe: true });
  }

  // Production phase-first capture: a matched job + a phase key runs the phase
  // engine. Unknown keys triage (phaseLinked:false) — the photo is kept either way.
  let phaseLinked: boolean | undefined;
  if (body.phaseKey && match?.jobId) {
    const linked = await ingestProductionMedia({
      tenantId: t.tenantId,
      jobId: match.jobId,
      phaseKey: body.phaseKey,
      documentId: rec.documentId,
      shot: body.shot ?? null,
      crewMemberName: body.crewMemberName ?? null,
      capturedAt: body.capturedAtMs ? new Date(body.capturedAtMs) : null,
    });
    phaseLinked = "phaseId" in linked;
    if (rec.created && phaseLinked && deps.emitProductionMedia && "phaseId" in linked) {
      try {
        await deps.emitProductionMedia({
          tenantId: t.tenantId, jobId: match.jobId, phaseKey: body.phaseKey,
          documentId: rec.documentId, phaseStatus: linked.phaseStatus, justCompleted: linked.justCompleted,
        });
      } catch { /* noop */ }
    }
  }

  const base = { ok: true, matched: match != null, documentId: rec.documentId };
  return {
    status: 200,
    body: {
      ...base,
      ...(wantsInspection ? { inspectionLinked } : {}),
      ...(body.phaseKey ? { phaseLinked: phaseLinked ?? false } : {}),
    },
  };
}
