import { describe, it, expect } from "vitest";
import {
  dollarsToCents,
  mapEstimate,
  mapInvoice,
  mapCommChannel,
  mapDocKind,
  attachmentR2Key,
} from "./acculynx-attachments";

describe("dollarsToCents", () => {
  it("rounds dollars to integer cents", () => {
    expect(dollarsToCents(9267.22)).toBe(926722);
    expect(dollarsToCents(4500)).toBe(450000);
    expect(dollarsToCents(0)).toBe(0);
    expect(dollarsToCents(10.005)).toBe(1001); // half-up
  });
  it("treats null/undefined/NaN as null (never NaN into an int column)", () => {
    expect(dollarsToCents(null)).toBeNull();
    expect(dollarsToCents(undefined)).toBeNull();
    expect(dollarsToCents(Number.NaN)).toBeNull();
  });
});

describe("mapEstimate", () => {
  it("maps an AccuLynx estimate to Savvy estimate columns (money → cents)", () => {
    const e = mapEstimate({
      Id: "est-1", Title: "Class 4 High Impact Shingle Estimate", EstimateNumber: "",
      TotalCost: 6310.34, TotalPrice: 9267.22, TotalProfit: 2956.88, TotalTaxes: 0,
      IsPrimary: true, CreatedTimestamp: "2026-02-24T12:00:00Z", Sections: [{ x: 1 }],
    });
    expect(e).toMatchObject({
      externalId: "estimate:est-1",
      source: "carrier",
      status: "accepted", // primary → accepted
      total: 926722,
      subtotal: 631034, // cost
      tax: 0,
      title: "Class 4 High Impact Shingle Estimate",
    });
    expect(e.lineItems).toEqual([{ x: 1 }]);
    expect(e.createdAt instanceof Date).toBe(true);
  });
  it("non-primary estimate → draft status", () => {
    expect(mapEstimate({ Id: "e2", IsPrimary: false, TotalPrice: 100 }).status).toBe("draft");
  });
});

describe("mapInvoice", () => {
  it("maps an AccuLynx invoice (money → cents, status from paid state)", () => {
    const inv = mapInvoice({
      InvoiceId: "inv-1", InvoiceNumber: "4-1", Title: "Rebekah Scott",
      Total: 9267.22, BalanceDue: 4767.22, LinkedPaymentTotal: 4500,
      IsPaid: false, InvoiceDate: "2026-02-26T00:00:00", DueDate: null,
      InvoiceWorksheetSections: [{ s: 1 }],
    });
    expect(inv).toMatchObject({
      externalId: "invoice:inv-1",
      number: "4-1",
      status: "sent", // has balance, not paid
      amountDue: 926722,
      amountPaid: 450000,
    });
    expect(inv.lineItems).toEqual([{ s: 1 }]);
  });
  it("fully paid invoice → status paid", () => {
    expect(mapInvoice({ InvoiceId: "i", Total: 100, BalanceDue: 0, IsPaid: true }).status).toBe("paid");
  });
});

describe("mapCommChannel", () => {
  it("maps AccuLynx thread type names to Savvy comm channels", () => {
    expect(mapCommChannel("Email")).toBe("email");
    expect(mapCommChannel("Text Message")).toBe("sms");
    expect(mapCommChannel("Phone Call")).toBe("call");
    // internal team threads have no real channel → email is the closest text home
    expect(mapCommChannel("Job Message")).toBe("email");
    expect(mapCommChannel("Mobile Crew App")).toBe("email");
    expect(mapCommChannel("")).toBe("email");
    expect(mapCommChannel(undefined)).toBe("email");
  });
});

describe("mapDocKind", () => {
  it("maps AccuLynx folder names to Savvy document kinds", () => {
    expect(mapDocKind("Insurance Estimate")).toBe("insurance_estimate");
    expect(mapDocKind("Roof Report")).toBe("measurement_report");
    expect(mapDocKind("Alta Insurance Contract")).toBe("contract");
    expect(mapDocKind("Certificate of Completion")).toBe("cert");
    expect(mapDocKind("Invoice")).toBe("other");
    expect(mapDocKind("Permit")).toBe("other");
    expect(mapDocKind("Warranty")).toBe("other");
    expect(mapDocKind("Email Documents")).toBe("other");
    expect(mapDocKind("Anything Else")).toBe("other");
  });
});

describe("attachmentR2Key", () => {
  it("builds a deterministic tenant/job-scoped key", () => {
    const k = attachmentR2Key("ten-1", "job-9", "photo", "file-7", "IMG_1.jpg");
    expect(k).toBe("acculynx/ten-1/job-9/photo/file-7_IMG_1.jpg");
  });
  it("sanitizes unsafe characters in the filename", () => {
    expect(attachmentR2Key("t", "j", "doc", "f", "a b/c?.pdf")).toBe("acculynx/t/j/doc/f_a-b-c-.pdf");
  });
});
