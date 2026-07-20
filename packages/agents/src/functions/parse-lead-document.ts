import { getDocumentForParse, upsertUploadedMeasurement, setDocumentParseStatus, attachOrCreateClaim, withAgentRun } from "@savvy/db";
import { completeObject } from "@savvy/ai";
import {
  measurementReportParseSchema, MEASUREMENT_PARSE_MIN_CONFIDENCE, type MeasurementReportParse,
  insuranceEstimateParseSchema, INSURANCE_PARSE_MIN_CONFIDENCE, type InsuranceEstimateParse,
} from "@savvy/core";
import { r2Storage } from "@savvy/integrations";
import { inngest } from "../client";

const PARSE_SYSTEM =
  "You are a roofing measurement estimator. Extract a roof measurement report (Roofr, EagleView, or similar) " +
  "into structured areas. All lengths are linear feet; squares are roofing squares (100 sq ft). If a field is " +
  "missing, use 0. Confidence is your 0-1 certainty the extraction faithfully reflects the document.";

const PARSE_PROMPT =
  "Extract this roof measurement report: total squares, predominant pitch (e.g. \"8/12\"), and the linear-foot " +
  "totals for ridge, hip, valley, eave, rake, and step flashing, plus penetration count and facet count.";

const INSURANCE_SYSTEM =
  "You are a roofing insurance-claims analyst. Extract a carrier insurance estimate (Xactimate or similar) " +
  "into structured data. Report all money in integer cents. If a field is missing, use null. Confidence is " +
  "your 0-1 certainty the extraction faithfully reflects the document.";
const INSURANCE_PROMPT =
  "Extract this insurance estimate: carrier name, claim number, ACV/RCV/deductible in cents, and every line " +
  "item with its description, quantity, unit (if shown), unit price in cents, and line amount in cents.";

export type ParseLeadDocumentDeps = {
  loadDoc: (tenantId: string, documentId: string) => Promise<{ r2Key: string | null; kind: string; leadId: string | null; jobId: string | null; propertyId: string | null } | null>;
  fetchBytes: (key: string) => Promise<Uint8Array>;
  // Typed via `typeof completeObject` (not a hand-rolled signature) so schemas with
  // `.default()` fields (measurementReportParseSchema) don't trip a ZodType<T> input/
  // output-variance mismatch against the real generic @savvy/ai signature.
  ai: Pick<typeof import("@savvy/ai"), "completeObject">;
  insertMeasurement: (input: { tenantId: string; propertyId: string; areas: Record<string, unknown>; pitch: string | null }) => Promise<string>;
  setStatus: (input: { tenantId: string; documentId: string; status: string; confidence?: number | null }) => Promise<void>;
  attachClaim: (input: { tenantId: string; leadId: string | null; jobId: string | null; propertyId: string | null; carrierName: string | null; claimNumber: string | null; acvCents: number | null; rcvCents: number | null; deductibleCents: number | null; lineItems: InsuranceEstimateParse["lines"]; parseConfidence: number }) => Promise<{ claimId: string; created: boolean }>;
  /**
   * Wraps the slow parse body with a live agent_run attributed to the lead
   * (opens `running`, resolves via `resolve` on success). Injected so this
   * handler stays pure/deps-injected — the real wiring uses `withAgentRun`.
   */
  withRun: <T>(
    meta: { taskKey: string; leadId: string | null },
    work: () => Promise<T>,
    resolve: (r: T) => { status: "ok" | "skipped" | "error"; error?: string | null },
  ) => Promise<T>;
};

/**
 * Parse one uploaded lead document, dispatching by kind. `measurement_report`: load its
 * PDF → parse via the AI gateway → insert an `uploaded_report` measurement → mark the doc
 * parsed. `insurance_estimate`: load its PDF → parse via the AI gateway → attach/create
 * the lead's claim → mark the doc parsed. Low confidence (either kind) → card as
 * `unparsed_low_confidence` (no measurement/claim written). Any error → `parse_failed`.
 * Unrecognized kinds → `skipped`. FAIL-SOFT: never throws.
 */
export async function parseLeadDocumentHandler(
  input: { tenantId: string; documentId: string },
  deps: ParseLeadDocumentDeps,
): Promise<{ status: "parsed" | "unparsed_low_confidence" | "parse_failed" | "skipped"; measurementId?: string; claimId?: string; leadId?: string | null; propertyId?: string | null }> {
  const { tenantId, documentId } = input;
  try {
    const doc = await deps.loadDoc(tenantId, documentId);
    if (!doc) return { status: "parse_failed" };

    // Unrecognized kinds are a no-op — decide that BEFORE opening a run so we
    // never flash an in-flight card for a doc we're not going to parse.
    if (doc.kind !== "measurement_report" && doc.kind !== "insurance_estimate") {
      return { status: "skipped" };
    }

    return await deps.withRun(
      { taskKey: "lead.doc_parse", leadId: doc.leadId },
      async () => {
        if (!doc.r2Key) throw new Error("lead document missing storage key");
        const bytes = await deps.fetchBytes(doc.r2Key);

        if (doc.kind === "measurement_report") {
          if (!doc.propertyId) throw new Error("measurement document missing property");
          // measurementReportParseSchema's `.default()` fields give it a wider Input than
          // Output, which trips inference/assignability through the generic
          // completeObject<T>(schema: z.ZodType<T>) signature (z.ZodType defaults Input=T).
          // Pin T explicitly and cast the schema arg through `unknown` — a well-understood
          // Zod-defaults variance quirk, not a real type-safety gap (the object shape is
          // identical; only the optional-on-input side differs).
          const { object: parsed } = await deps.ai.completeObject<MeasurementReportParse>({
            capability: "reasoning",
            system: PARSE_SYSTEM,
            prompt: PARSE_PROMPT,
            schema: measurementReportParseSchema as unknown as Parameters<typeof deps.ai.completeObject<MeasurementReportParse>>[0]["schema"],
            file: { bytes, mediaType: "application/pdf" },
          });
          if (parsed.confidence < MEASUREMENT_PARSE_MIN_CONFIDENCE) {
            await deps.setStatus({ tenantId, documentId, status: "unparsed_low_confidence", confidence: parsed.confidence });
            return { status: "unparsed_low_confidence" as const };
          }
          const { confidence, ...areas } = parsed;
          const measurementId = await deps.insertMeasurement({ tenantId, propertyId: doc.propertyId, areas, pitch: areas.predominantPitch });
          await deps.setStatus({ tenantId, documentId, status: "parsed", confidence });
          return { status: "parsed" as const, measurementId, leadId: doc.leadId, propertyId: doc.propertyId };
        }

        // doc.kind === "insurance_estimate" — attach the claim to the lead, or
        // to the job when the estimate lives on a job (no lead), e.g. a bulk-
        // imported carrier estimate.
        if (!doc.leadId && !doc.jobId) throw new Error("insurance document missing lead and job");
        const { object: parsed } = await deps.ai.completeObject<InsuranceEstimateParse>({
          capability: "reasoning",
          system: INSURANCE_SYSTEM,
          prompt: INSURANCE_PROMPT,
          schema: insuranceEstimateParseSchema as unknown as Parameters<typeof deps.ai.completeObject<InsuranceEstimateParse>>[0]["schema"],
          file: { bytes, mediaType: "application/pdf" },
        });
        if (parsed.confidence < INSURANCE_PARSE_MIN_CONFIDENCE) {
          await deps.setStatus({ tenantId, documentId, status: "unparsed_low_confidence", confidence: parsed.confidence });
          return { status: "unparsed_low_confidence" as const };
        }
        const { claimId } = await deps.attachClaim({
          tenantId, leadId: doc.leadId, jobId: doc.jobId, propertyId: doc.propertyId,
          carrierName: parsed.carrierName, claimNumber: parsed.claimNumber,
          acvCents: parsed.acvCents, rcvCents: parsed.rcvCents, deductibleCents: parsed.deductibleCents,
          lineItems: parsed.lines, parseConfidence: parsed.confidence,
        });
        await deps.setStatus({ tenantId, documentId, status: "parsed", confidence: parsed.confidence });
        return { status: "parsed" as const, claimId, leadId: doc.leadId };
      },
      (r) =>
        r.status === "unparsed_low_confidence"
          ? { status: "skipped" }
          : { status: "ok" },
    );
  } catch {
    await deps.setStatus({ tenantId, documentId, status: "parse_failed" }).catch(() => {});
    return { status: "parse_failed" };
  }
}

export const parseLeadDocument = inngest.createFunction(
  // Serialize per document (scopeId = lead or job it hangs off, else the doc id)
  // so two parses of the same subject can't race to create duplicate claims.
  { id: "parse-lead-document", concurrency: [{ limit: 5, key: "event.data.tenantId" }, { limit: 1, key: "event.data.scopeId" }], retries: 2 },
  { event: "lead-document/received" },
  async ({ event, step }) => {
    const { tenantId, documentId } = event.data as { tenantId: string; documentId: string; kind?: string; scopeId?: string };

    const result = await step.run("parse", () =>
      parseLeadDocumentHandler(
        { tenantId, documentId },
        {
          loadDoc: (t, d) => getDocumentForParse(t, d),
          fetchBytes: async (key) => {
            // R2 isn't wired in e2e (the upload action stubs storage under TEST_MODE);
            // return a minimal PDF header so the pipeline stays exercisable — the stubbed
            // AI gateway ignores the bytes anyway.
            if (process.env.TEST_MODE === "1") return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
            const { url } = await r2Storage.presignDownload({ key });
            const res = await fetch(url);
            if (!res.ok) throw new Error(`fetch ${res.status}`);
            return new Uint8Array(await res.arrayBuffer());
          },
          ai: { completeObject },
          insertMeasurement: (i) => upsertUploadedMeasurement(i),
          setStatus: (i) => setDocumentParseStatus(i),
          attachClaim: (i) => attachOrCreateClaim(i),
          withRun: (meta, work, resolve) =>
            withAgentRun({ tenantId, agent: "orchestrator", taskKey: meta.taskKey, leadId: meta.leadId }, work, { resolve }),
        },
      ),
    );

    // An uploaded measurement feeds the same estimate auto-draft as a Roofr order.
    if (result.status === "parsed" && result.measurementId) {
      await step.sendEvent("emit-ready", {
        name: "measurement/ready",
        data: {
          tenantId,
          measurementId: result.measurementId,
          propertyId: result.propertyId ?? undefined,
          leadId: result.leadId ?? undefined,
        },
      });
    }
    return result;
  },
);
