import { describe, it, expect, vi } from "vitest";
import { priceGuardHandler } from "./supplier-invoice-guard";

const cfg = { minOverageCents: 2500, overagePct: 0.05, autoSendMinCents: 2500, highConfidence: 0.8 };
const invoice = {
  jobId: "job-1", supplierName: "ABC Supply", invoiceNumber: "INV-9", parseConfidence: 0.92, totalCents: 240000,
  lines: [{ description: "GAF Timberline HDZ", sku: "shingle-hdz", quantity: 30, unitBilledCents: 8000, amountBilledCents: 240000 }],
};
const snapshot = [{ key: "shingle-hdz", name: "GAF Timberline HDZ", unitCostCents: 7000 }];

const baseDeps = () => ({
  loadInvoice: vi.fn().mockResolvedValue(invoice),
  loadSnapshot: vi.fn().mockResolvedValue(snapshot),
  loadConfig: vi.fn().mockResolvedValue(cfg),
  saveGuarded: vi.fn().mockResolvedValue(undefined),
  createCredit: vi.fn().mockResolvedValue({ id: "cr-1" }),
  sendEmail: vi.fn().mockResolvedValue({ id: "email-1" }),
  recordRun: vi.fn().mockResolvedValue(undefined),
  gate: vi.fn().mockResolvedValue({ proceed: true, level: "full" }),
  raiseDraftCard: vi.fn().mockResolvedValue(undefined),
});
const input = { tenantId: "t", supplierInvoiceId: "si" };

describe("priceGuardHandler", () => {
  it("guards, detects the overage, and auto-sends a credit request when confident + gated open", async () => {
    const deps = baseDeps();
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guarded");
    expect(res.claimedCents).toBe(30000); // (8000-7000)*30
    // guarded lines carry the verdict
    expect(deps.saveGuarded).toHaveBeenCalledWith("t", "si", [expect.objectContaining({ matchedItemKey: "shingle-hdz", expectedUnitCostCents: 7000, overageCents: 30000 })]);
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "sent", claimedCents: 30000, supplierInvoiceId: "si" }));
    expect(deps.sendEmail).toHaveBeenCalled();
    expect(deps.recordRun).toHaveBeenCalled();
    expect(deps.raiseDraftCard).not.toHaveBeenCalled();
  });

  it("drafts + raises a Today card when parse confidence is low (never unattended-emails)", async () => {
    const deps = baseDeps();
    deps.loadInvoice = vi.fn().mockResolvedValue({ ...invoice, parseConfidence: 0.5 });
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guarded");
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "drafted" }));
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.raiseDraftCard).toHaveBeenCalled();
  });

  it("drafts (no email) when the automation gate is closed", async () => {
    const deps = baseDeps();
    deps.gate = vi.fn().mockResolvedValue({ proceed: false, level: "review" });
    await priceGuardHandler(input, deps);
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "drafted" }));
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("guards with no credit request when there is no qualifying overage", async () => {
    const deps = baseDeps();
    deps.loadInvoice = vi.fn().mockResolvedValue({ ...invoice, lines: [{ description: "GAF Timberline HDZ", sku: "shingle-hdz", quantity: 1, unitBilledCents: 7010, amountBilledCents: 7010 }] });
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guarded");
    expect(res.claimedCents).toBe(0);
    expect(deps.createCredit).not.toHaveBeenCalled();
  });

  it("skips credit memos (negative total) for the recovery path", async () => {
    const deps = baseDeps();
    deps.loadInvoice = vi.fn().mockResolvedValue({ ...invoice, totalCents: -240000 });
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guard_skipped");
    expect(deps.saveGuarded).not.toHaveBeenCalled();
  });

  it("is fail-soft: a load error returns guard_skipped and does not throw", async () => {
    const deps = baseDeps();
    deps.loadInvoice = vi.fn().mockRejectedValue(new Error("db down"));
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guard_skipped");
  });
});
