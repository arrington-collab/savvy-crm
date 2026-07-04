import { describe, it, expect, vi } from "vitest";
import { parseSupplierInvoiceHandler } from "./supplier-invoice-parse";

// A canned parse result the stubbed AI gateway "returns" for the invoice PDF.
const parsed = {
  supplierName: "ABC Supply",
  invoiceNumber: "INV-9",
  invoiceDate: "2026-07-01",
  totalCents: 812300,
  lines: [{ description: "GAF HDZ Charcoal", quantity: 30, unitBilledCents: 27000, amountBilledCents: 810000 }],
  confidence: 0.92,
};

// Fully-injected deps → the handler is pure-testable without Inngest/R2/DB/AI.
const baseDeps = () => ({
  ai: { completeObject: vi.fn().mockResolvedValue({ object: parsed, model: "stub" }) },
  fetchBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
  loadDocKey: vi.fn().mockResolvedValue("tenant/t/supplier-invoice/x.pdf"),
  matchJob: vi.fn().mockResolvedValue("job-1"),
  save: vi.fn().mockResolvedValue(undefined),
  recompute: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
});

const input = { tenantId: "t", supplierInvoiceId: "si", documentId: "d" };

describe("parseSupplierInvoiceHandler", () => {
  it("parses, saves, and recomputes job cost", async () => {
    const deps = baseDeps();
    const res = await parseSupplierInvoiceHandler(input, deps);
    expect(res.status).toBe("parsed");
    expect(res.jobId).toBe("job-1");
    expect(deps.loadDocKey).toHaveBeenCalledWith("t", "d");
    expect(deps.fetchBytes).toHaveBeenCalledWith("tenant/t/supplier-invoice/x.pdf");
    expect(deps.ai.completeObject).toHaveBeenCalled();
    expect(deps.save).toHaveBeenCalledWith(
      "t",
      "si",
      expect.objectContaining({ jobId: "job-1", totalCents: 812300, confidence: 0.92, invoiceNumber: "INV-9" }),
    );
    expect(deps.recompute).toHaveBeenCalledWith("t", "job-1");
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("still persists but skips cost recompute when no job matches (unmatched invoice)", async () => {
    const deps = baseDeps();
    deps.matchJob = vi.fn().mockResolvedValue(null);
    const res = await parseSupplierInvoiceHandler(input, deps);
    expect(res.status).toBe("parsed");
    expect(res.jobId).toBeNull();
    expect(deps.save).toHaveBeenCalledWith("t", "si", expect.objectContaining({ jobId: null }));
    expect(deps.recompute).not.toHaveBeenCalled();
  });

  it("is fail-soft: an AI error marks parse_failed and does not throw", async () => {
    const deps = baseDeps();
    deps.ai.completeObject = vi.fn().mockRejectedValue(new Error("bad pdf"));
    const res = await parseSupplierInvoiceHandler(input, deps);
    expect(res.status).toBe("parse_failed");
    expect(deps.markFailed).toHaveBeenCalledWith("t", "si");
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.recompute).not.toHaveBeenCalled();
  });

  it("is fail-soft when the document has no storage key", async () => {
    const deps = baseDeps();
    deps.loadDocKey = vi.fn().mockResolvedValue(null);
    const res = await parseSupplierInvoiceHandler(input, deps);
    expect(res.status).toBe("parse_failed");
    expect(deps.ai.completeObject).not.toHaveBeenCalled();
    expect(deps.markFailed).toHaveBeenCalledWith("t", "si");
  });
});
