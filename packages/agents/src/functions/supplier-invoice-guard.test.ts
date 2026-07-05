import { describe, it, expect, vi } from "vitest";
import { priceGuardHandler } from "./supplier-invoice-guard";

const cfg = { minOverageCents: 2500, overagePct: 0.05, autoSendMinCents: 2500, highConfidence: 0.8 };
const invoice = {
  jobId: "job-1", supplierName: "ABC Supply", invoiceNumber: "INV-9", parseConfidence: 0.92, totalCents: 240000, senderEmail: "ar@abcsupply.com",
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
  resolveRecipient: vi.fn().mockReturnValue("ar@abcsupply.com"),
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
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guarded");
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "drafted" }));
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.raiseDraftCard).toHaveBeenCalled();
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

  it("auto-sends to the resolved recipient address", async () => {
    const deps = baseDeps();
    await priceGuardHandler(input, deps);
    expect(deps.resolveRecipient).toHaveBeenCalledWith("ar@abcsupply.com");
    expect(deps.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ar@abcsupply.com" }));
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "sent" }));
  });

  it("drafts (no email) when the recipient does not resolve, even if confident + gated open", async () => {
    const deps = baseDeps();
    deps.resolveRecipient = vi.fn().mockReturnValue(null); // e.g. self-domain / missing sender
    const res = await priceGuardHandler(input, deps);
    expect(res.status).toBe("guarded");
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.createCredit).toHaveBeenCalledWith("t", expect.objectContaining({ status: "drafted" }));
    expect(deps.raiseDraftCard).toHaveBeenCalled();
  });
});

import { recoverCreditMemoHandler } from "./supplier-invoice-guard";

const memoDeps = () => ({
  loadInvoice: vi.fn().mockResolvedValue({ supplierName: "ABC Supply", totalCents: -30000 }),
  listOpen: vi.fn().mockResolvedValue([{ id: "cr-1", supplierName: "ABC Supply", claimedCents: 30000 }]),
  markCredited: vi.fn().mockResolvedValue(undefined),
  raiseReconcileCard: vi.fn().mockResolvedValue(undefined),
});

describe("recoverCreditMemoHandler", () => {
  it("auto-credits the one matching open request", async () => {
    const deps = memoDeps();
    const res = await recoverCreditMemoHandler({ tenantId: "t", supplierInvoiceId: "memo" }, deps);
    expect(res.status).toBe("credited");
    expect(deps.markCredited).toHaveBeenCalledWith("t", "cr-1", 30000);
    expect(deps.raiseReconcileCard).not.toHaveBeenCalled();
  });
  it("raises a reconcile card when no unique match", async () => {
    const deps = memoDeps();
    deps.listOpen = vi.fn().mockResolvedValue([]);
    const res = await recoverCreditMemoHandler({ tenantId: "t", supplierInvoiceId: "memo" }, deps);
    expect(res.status).toBe("reconcile");
    expect(deps.raiseReconcileCard).toHaveBeenCalled();
  });
  it("skips a non-memo (positive total)", async () => {
    const deps = memoDeps();
    deps.loadInvoice = vi.fn().mockResolvedValue({ supplierName: "ABC", totalCents: 500 });
    const res = await recoverCreditMemoHandler({ tenantId: "t", supplierInvoiceId: "x" }, deps);
    expect(res.status).toBe("skipped");
  });
});
