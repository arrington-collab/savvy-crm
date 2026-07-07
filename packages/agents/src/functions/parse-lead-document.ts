import { getLeadDocumentForParse, insertUploadedMeasurement, setDocumentParseStatus } from "@savvy/db";
import { completeObject } from "@savvy/ai";
import { measurementReportParseSchema, MEASUREMENT_PARSE_MIN_CONFIDENCE, type MeasurementReportParse } from "@savvy/core";
import { r2Storage } from "@savvy/integrations";
import { inngest } from "../client";

const PARSE_SYSTEM =
  "You are a roofing measurement estimator. Extract a roof measurement report (Roofr, EagleView, or similar) " +
  "into structured areas. All lengths are linear feet; squares are roofing squares (100 sq ft). If a field is " +
  "missing, use 0. Confidence is your 0-1 certainty the extraction faithfully reflects the document.";

const PARSE_PROMPT =
  "Extract this roof measurement report: total squares, predominant pitch (e.g. \"8/12\"), and the linear-foot " +
  "totals for ridge, hip, valley, eave, rake, and step flashing, plus penetration count and facet count.";

export type ParseLeadDocumentDeps = {
  loadDoc: (tenantId: string, documentId: string) => Promise<{ r2Key: string | null; kind: string; leadId: string | null; propertyId: string | null } | null>;
  fetchBytes: (key: string) => Promise<Uint8Array>;
  // Typed via `typeof completeObject` (not a hand-rolled signature) so schemas with
  // `.default()` fields (measurementReportParseSchema) don't trip a ZodType<T> input/
  // output-variance mismatch against the real generic @savvy/ai signature.
  ai: Pick<typeof import("@savvy/ai"), "completeObject">;
  insertMeasurement: (input: { tenantId: string; propertyId: string; areas: Record<string, unknown>; pitch: string | null }) => Promise<string>;
  setStatus: (input: { tenantId: string; documentId: string; status: string; confidence?: number | null }) => Promise<void>;
};

/**
 * Parse one uploaded lead document. For `measurement_report`: load its PDF → parse
 * via the AI gateway → insert an `uploaded_report` measurement → mark the doc parsed.
 * Low confidence → card as `unparsed_low_confidence` (no measurement). Any error →
 * `parse_failed`. Non-measurement kinds (insurance_estimate is 6c) → `skipped`.
 * FAIL-SOFT: never throws.
 */
export async function parseLeadDocumentHandler(
  input: { tenantId: string; documentId: string },
  deps: ParseLeadDocumentDeps,
): Promise<{ status: "parsed" | "unparsed_low_confidence" | "parse_failed" | "skipped"; measurementId?: string; leadId?: string | null; propertyId?: string | null }> {
  const { tenantId, documentId } = input;
  try {
    const doc = await deps.loadDoc(tenantId, documentId);
    if (!doc) return { status: "parse_failed" };
    if (doc.kind !== "measurement_report") return { status: "skipped" };
    if (!doc.r2Key || !doc.propertyId) throw new Error("measurement document missing key or property");

    const bytes = await deps.fetchBytes(doc.r2Key);
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
      return { status: "unparsed_low_confidence" };
    }

    const { confidence, ...areas } = parsed;
    const measurementId = await deps.insertMeasurement({
      tenantId, propertyId: doc.propertyId, areas, pitch: areas.predominantPitch,
    });
    await deps.setStatus({ tenantId, documentId, status: "parsed", confidence });
    return { status: "parsed", measurementId, leadId: doc.leadId, propertyId: doc.propertyId };
  } catch {
    await deps.setStatus({ tenantId, documentId, status: "parse_failed" }).catch(() => {});
    return { status: "parse_failed" };
  }
}

export const parseLeadDocument = inngest.createFunction(
  { id: "parse-lead-document", concurrency: { limit: 5, key: "event.data.tenantId" }, retries: 2 },
  { event: "lead-document/received" },
  async ({ event, step }) => {
    const { tenantId, documentId } = event.data as { tenantId: string; documentId: string; kind?: string };

    const result = await step.run("parse", () =>
      parseLeadDocumentHandler(
        { tenantId, documentId },
        {
          loadDoc: (t, d) => getLeadDocumentForParse(t, d),
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
          insertMeasurement: (i) => insertUploadedMeasurement(i),
          setStatus: (i) => setDocumentParseStatus(i),
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
