import {
  getDocumentR2Key, matchSupplierInvoiceJob, saveParsedSupplierInvoice,
  recomputeJobActualCost, markSupplierInvoiceParseFailed,
} from "@savvy/db";
import { completeObject } from "@savvy/ai";
import { supplierInvoiceParseSchema, type SupplierInvoiceParse } from "@savvy/core";
import { r2Storage } from "@savvy/integrations";
import { inngest } from "../client";

const PARSE_SYSTEM =
  "You are a roofing-operations bookkeeper. Extract a supplier material invoice (ABC Supply, SRS, " +
  "Beacon, …) into structured data. Report money in integer cents. If a field is missing, use null. " +
  "Confidence is your 0–1 certainty that the extraction faithfully reflects the document.";

const PARSE_PROMPT =
  "Extract this supplier invoice: the supplier name, invoice number, invoice date (ISO yyyy-mm-dd or null), " +
  "the grand total in cents, and every line item with its description, SKU (if shown), quantity, unit, " +
  "billed unit price in cents (unitBilledCents), and billed line amount in cents (amountBilledCents).";

/**
 * Dependencies injected so the handler is pure-testable without Inngest, R2, the
 * AI gateway, or a DB (mirrors the photo-qc `runPhotoQc` pattern). Real wiring is
 * supplied by the exported Inngest function below.
 */
export type ParseSupplierInvoiceDeps = {
  ai: {
    completeObject: (opts: {
      capability: "reasoning";
      prompt: string;
      system?: string;
      schema: typeof supplierInvoiceParseSchema;
      file?: { bytes: Uint8Array; mediaType: string };
    }) => Promise<{ object: SupplierInvoiceParse; model: string }>;
  };
  loadDocKey: (tenantId: string, documentId: string) => Promise<string | null>;
  fetchBytes: (key: string) => Promise<Uint8Array>;
  matchJob: (tenantId: string, parsed: SupplierInvoiceParse) => Promise<string | null>;
  save: (
    tenantId: string,
    id: string,
    parsed: {
      supplierName: string | null; invoiceNumber: string | null; invoiceDate: Date | null;
      totalCents: number; lines: SupplierInvoiceParse["lines"]; confidence: number; jobId: string | null;
    },
  ) => Promise<void>;
  recompute: (tenantId: string, jobId: string) => Promise<void>;
  markFailed: (tenantId: string, id: string) => Promise<void>;
};

/**
 * Parse one received supplier invoice: load its stored PDF → parse via the AI
 * gateway into `supplierInvoiceParseSchema` → match a job → persist parsed lines
 * (status=parsed) → recompute job.costCents from actuals (when matched).
 *
 * FAIL-SOFT: any error (missing key, R2/AI/DB failure) → mark the row parse_failed
 * and return `parse_failed`; NEVER throws, so a bad PDF can't wedge the queue.
 */
export async function parseSupplierInvoiceHandler(
  input: { tenantId: string; supplierInvoiceId: string; documentId: string },
  deps: ParseSupplierInvoiceDeps,
): Promise<{ status: "parsed" | "parse_failed"; jobId: string | null }> {
  const { tenantId, supplierInvoiceId, documentId } = input;
  try {
    const key = await deps.loadDocKey(tenantId, documentId);
    if (!key) throw new Error("supplier invoice document has no storage key");

    const bytes = await deps.fetchBytes(key);
    const { object: parsed } = await deps.ai.completeObject({
      capability: "reasoning",
      system: PARSE_SYSTEM,
      prompt: PARSE_PROMPT,
      schema: supplierInvoiceParseSchema,
      file: { bytes, mediaType: "application/pdf" },
    });

    const jobId = await deps.matchJob(tenantId, parsed);
    await deps.save(tenantId, supplierInvoiceId, {
      supplierName: parsed.supplierName,
      invoiceNumber: parsed.invoiceNumber,
      invoiceDate: parsed.invoiceDate ? new Date(parsed.invoiceDate) : null,
      totalCents: parsed.totalCents,
      lines: parsed.lines,
      confidence: parsed.confidence,
      jobId,
    });

    // Only a matched job gets its cost recomputed; unmatched invoices wait in the
    // "unmatched supplier invoice" tray (surfaced in Today) for 13c matching.
    if (jobId) await deps.recompute(tenantId, jobId);
    return { status: "parsed", jobId };
  } catch {
    await deps.markFailed(tenantId, supplierInvoiceId).catch(() => {});
    return { status: "parse_failed", jobId: null };
  }
}

// Per-tenant concurrency key so one tenant's invoice burst can't starve others.
export const parseSupplierInvoice = inngest.createFunction(
  { id: "parse-supplier-invoice", concurrency: { limit: 5, key: "event.data.tenantId" }, retries: 2 },
  { event: "supplier-invoice/received" },
  async ({ event, step }) => {
    const { tenantId, supplierInvoiceId, documentId } = event.data as {
      tenantId: string; supplierInvoiceId: string; documentId: string; emailBody?: string;
    };
    // Optional email body/subject text forwarded by the ingest route. Injected into
    // the parse prompt ONLY under TEST_MODE so e2e stubs can branch on a sentinel
    // string — production AI prompt behavior is intentionally left unchanged.
    const emailBody =
      process.env.TEST_MODE === "1" ? (event.data as { emailBody?: string }).emailBody : undefined;

    // The whole fail-soft parse runs inside one durable step (it never throws, so
    // it settles in a single attempt; retries guard only transient infra errors).
    const result = await step.run("parse", () =>
      parseSupplierInvoiceHandler(
        { tenantId, supplierInvoiceId, documentId },
        {
          ai: {
            // Append emailBody as extra context only under TEST_MODE (see above); e2e
            // stubs key on the sentinel embedded here. No-op in production (emailBody undefined).
            completeObject: (opts) => completeObject({
              ...opts,
              prompt: emailBody ? `${opts.prompt}

Email context: ${emailBody}` : opts.prompt,
            }),
          },
          loadDocKey: (t, d) => getDocumentR2Key(t, d),
          fetchBytes: async (key) => {
            // R2 is a commodity we don't wire in e2e (the ingest route stubs storage
            // under TEST_MODE too); return a minimal PDF header so the parse pipeline
            // stays exercisable — the stubbed AI gateway ignores the bytes anyway.
            if (process.env.TEST_MODE === "1") return new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
            const { url } = await r2Storage.presignDownload({ key });
            const res = await fetch(url);
            if (!res.ok) throw new Error(`fetch ${res.status}`);
            return new Uint8Array(await res.arrayBuffer());
          },
          matchJob: (t, parsed) => matchSupplierInvoiceJob(t, parsed),
          save: (t, id, parsed) => saveParsedSupplierInvoice(t, id, parsed),
          recompute: (t, jobId) => recomputeJobActualCost(t, jobId),
          markFailed: (t, id) => markSupplierInvoiceParseFailed(t, id),
        },
      ),
    );

    // Hand off to the 13c price-guard even when unmatched (jobId null) so the
    // guard/exception pipeline can still surface it.
    if (result.status === "parsed") {
      await step.sendEvent("emit-parsed", {
        name: "supplier-invoice/parsed",
        data: { tenantId, supplierInvoiceId, jobId: result.jobId },
      });
    }
    return result;
  },
);
