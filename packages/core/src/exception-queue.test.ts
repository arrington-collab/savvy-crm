import { describe, expect, it } from "vitest";
import { buildExceptionQueue, type ExceptionQueueInput } from "./exception-queue";

const base: ExceptionQueueInput = { atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [], materialDeliveries: [], taskNeedsApprovals: [], weatherAtRisks: [], roofTypeNeeded: [] };

describe("buildExceptionQueue", () => {
  it("normalizes each vector into an item with the right kind/severity/href", () => {
    const q = buildExceptionQueue({
      atRiskJobs: [{ jobId: "j1", customerName: "Ann", stuck: true, late: false, reasons: ["14d in production"], stageEnteredAt: new Date("2026-06-01T00:00:00Z") }],
      overdueInvoices: [{ invoiceId: "i1", jobId: "j2", customerName: "Bob", amountDueCents: 250000, dueAt: new Date("2026-06-10T00:00:00Z") }],
      missedAppointments: [{ appointmentId: "a1", jobId: "j3", apptType: "crew", status: "no_show", startsAt: new Date("2026-06-20T00:00:00Z"), customerName: "Cy" }],
      overdueTasks: [{ taskId: "t1", jobId: "j4", title: "Order materials", customerName: "Di", dueAt: new Date("2026-06-25T00:00:00Z") }],
      materialDeliveries: [],
      taskNeedsApprovals: [],
      weatherAtRisks: [],
      roofTypeNeeded: [],
    });
    expect(q.total).toBe(4);
    expect(q.counts).toEqual({ job_at_risk: 1, invoice_overdue: 1, appointment_missed: 1, task_overdue: 1, material_delivery: 0, task_needs_approval: 0, weather_at_risk: 0, roof_type_needed: 0, margin_outlier: 0, photo_incomplete: 0, photo_unmatched: 0 });
    const job = q.items.find((i) => i.kind === "job_at_risk")!;
    expect(job).toMatchObject({ severity: "medium", title: "Ann", href: "/jobs/j1" });
    expect(job.detail).toContain("14d in production");
    expect(q.items.find((i) => i.kind === "invoice_overdue")!).toMatchObject({ severity: "high", href: "/invoices" });
    expect(q.items.find((i) => i.kind === "appointment_missed")!).toMatchObject({ severity: "high", href: "/schedule" });
    expect(q.items.find((i) => i.kind === "task_overdue")!).toMatchObject({ severity: "medium", href: "/jobs/j4" });
  });

  it("surfaces a roof_type_needed item for a property missing its roof type", () => {
    const q = buildExceptionQueue({
      ...base,
      roofTypeNeeded: [{ jobId: "j9", leadId: "l9", propertyId: "p9", customerName: "Roof Ron", occurredAt: new Date("2026-06-15T00:00:00Z") }],
    });
    const item = q.items.find((i) => i.kind === "roof_type_needed")!;
    expect(item).toMatchObject({ severity: "medium", title: "Roof Ron", href: "/leads/l9" });
    expect(item.detail).toMatch(/roof type/i);
    expect(q.counts.roof_type_needed).toBe(1);
  });

  it("rates a late job high and a stuck-only job medium", () => {
    const q = buildExceptionQueue({
      ...base,
      atRiskJobs: [
        { jobId: "late", customerName: "L", stuck: false, late: true, reasons: ["past SLA"], stageEnteredAt: new Date("2026-06-01T00:00:00Z") },
        { jobId: "stuck", customerName: "S", stuck: true, late: false, reasons: ["stuck"], stageEnteredAt: new Date("2026-06-01T00:00:00Z") },
      ],
    });
    expect(q.items.find((i) => i.title === "L")!.severity).toBe("high");
    expect(q.items.find((i) => i.title === "S")!.severity).toBe("medium");
    expect(q.highCount).toBe(1);
  });

  it("sorts high before medium, then oldest occurredAt first", () => {
    const q = buildExceptionQueue({
      ...base,
      overdueInvoices: [
        { invoiceId: "new", jobId: "j", customerName: "New", amountDueCents: 100, dueAt: new Date("2026-06-26T00:00:00Z") },
        { invoiceId: "old", jobId: "j", customerName: "Old", amountDueCents: 100, dueAt: new Date("2026-06-01T00:00:00Z") },
      ],
      overdueTasks: [{ taskId: "t", jobId: "j", title: "x", customerName: "Task", dueAt: new Date("2026-06-15T00:00:00Z") }],
    });
    // both invoices are high (older first), task is medium (last)
    expect(q.items.map((i) => i.title)).toEqual(["Old", "New", "Task"]);
  });

  it("rates an overdue (not no_show) appointment medium", () => {
    const q = buildExceptionQueue({
      ...base,
      missedAppointments: [{ appointmentId: "a", jobId: "j", apptType: "inspection", status: "scheduled", startsAt: new Date("2026-06-20T00:00:00Z"), customerName: "Ov" }],
    });
    expect(q.items[0]!.severity).toBe("medium");
  });

  it("sorts a null occurredAt last within its severity group", () => {
    const q = buildExceptionQueue({
      ...base,
      // both high (invoices); the one with a null dueAt must sort AFTER the dated one
      overdueInvoices: [
        { invoiceId: "nulldate", jobId: "j", customerName: "NoDate", amountDueCents: 100, dueAt: null },
        { invoiceId: "dated", jobId: "j", customerName: "Dated", amountDueCents: 100, dueAt: new Date("2026-06-01T00:00:00Z") },
      ],
    });
    expect(q.items.map((i) => i.title)).toEqual(["Dated", "NoDate"]);
  });

  it("is empty for no input", () => {
    expect(buildExceptionQueue(base)).toEqual({
      items: [], counts: { job_at_risk: 0, invoice_overdue: 0, appointment_missed: 0, task_overdue: 0, material_delivery: 0, task_needs_approval: 0, weather_at_risk: 0, roof_type_needed: 0, margin_outlier: 0, photo_incomplete: 0, photo_unmatched: 0 }, total: 0, highCount: 0,
    });
  });

  describe("margin_outlier vector", () => {
    it("emits a high item when margin is negative and medium when merely thin", () => {
      const q = buildExceptionQueue({
        ...base,
        marginOutliers: [
          { jobId: "jm1", customerName: "Neg", marginPct: -5, occurredAt: new Date("2026-06-01T00:00:00Z") },
          { jobId: "jm2", customerName: "Thin", marginPct: 8, occurredAt: new Date("2026-06-02T00:00:00Z") },
        ],
      });
      expect(q.counts.margin_outlier).toBe(2);
      const neg = q.items.find((i) => i.title === "Neg")!;
      expect(neg).toMatchObject({ kind: "margin_outlier", severity: "high", href: "/jobs/jm1" });
      expect(neg.detail).toContain("-5%");
      expect(q.items.find((i) => i.title === "Thin")!.severity).toBe("medium");
    });
  });

  describe("photo_incomplete vector", () => {
    it("emits a medium item listing the missing required photos", () => {
      const q = buildExceptionQueue({
        ...base,
        photoIncomplete: [
          { jobId: "jp1", customerName: "Pat", missing: ["before", "after"], occurredAt: new Date("2026-06-03T00:00:00Z") },
        ],
      });
      expect(q.counts.photo_incomplete).toBe(1);
      const it0 = q.items.find((i) => i.kind === "photo_incomplete")!;
      expect(it0).toMatchObject({ severity: "medium", title: "Pat", href: "/jobs/jp1" });
      expect(it0.detail.toLowerCase()).toContain("before");
      expect(it0.detail.toLowerCase()).toContain("after");
    });
  });

  it("emits a photo_unmatched exception per unmatched photo", () => {
    const q = buildExceptionQueue({
      atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [],
      materialDeliveries: [], taskNeedsApprovals: [], weatherAtRisks: [], roofTypeNeeded: [],
      marginOutliers: [], photoIncomplete: [],
      photoUnmatched: [{ documentId: "d1", captureAddress: "77 Lost Ln", occurredAt: new Date() }],
    });
    const row = q.items.find((i) => i.kind === "photo_unmatched");
    expect(row).toBeTruthy();
    expect(row!.detail).toContain("77 Lost Ln");
  });

  describe("buildExceptionQueue material_delivery vector", () => {
    const baseInput = { atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [], materialDeliveries: [], taskNeedsApprovals: [], weatherAtRisks: [] };
    const install = new Date("2026-07-10T17:00:00Z");

    it("emits a high item when the order is misaligned (neededBy after install)", () => {
      const q = buildExceptionQueue({
        ...baseInput,
        materialDeliveries: [{
          materialOrderId: "mo1", jobId: "j1", customerName: "Misa Mary",
          neededByAt: new Date("2026-07-11T17:00:00Z"), installAt: install, createdAt: new Date("2026-07-01T00:00:00Z"),
        }],
      });
      const row = q.items.find((i) => i.kind === "material_delivery");
      expect(row).toBeTruthy();
      expect(row!.severity).toBe("high");
      expect(row!.title).toBe("Misa Mary");
      expect(row!.detail).toBe("Materials arrive after install");
      expect(row!.href).toBe("/jobs/j1");
      expect(row!.occurredAt).toEqual(install);
      expect(q.counts.material_delivery).toBe(1);
    });

    it("emits a medium item when there is no scheduled install", () => {
      const created = new Date("2026-07-02T00:00:00Z");
      const q = buildExceptionQueue({
        ...baseInput,
        materialDeliveries: [{
          materialOrderId: "mo2", jobId: "j2", customerName: "Noin Ned",
          neededByAt: new Date("2026-07-09T17:00:00Z"), installAt: null, createdAt: created,
        }],
      });
      const row = q.items.find((i) => i.kind === "material_delivery");
      expect(row!.severity).toBe("medium");
      expect(row!.detail).toBe("No install scheduled for materials");
      expect(row!.occurredAt).toEqual(created);
    });

    it("omits an aligned order (neededBy on/before install)", () => {
      const q = buildExceptionQueue({
        ...baseInput,
        materialDeliveries: [{
          materialOrderId: "mo3", jobId: "j3", customerName: "Fine Fran",
          neededByAt: new Date("2026-07-08T17:00:00Z"), installAt: install, createdAt: new Date(),
        }],
      });
      expect(q.items.some((i) => i.kind === "material_delivery")).toBe(false);
      expect(q.counts.material_delivery).toBe(0);
    });
  });

  describe("buildExceptionQueue task_needs_approval vector", () => {
    const base = { atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [], materialDeliveries: [], taskNeedsApprovals: [], weatherAtRisks: [] };
    it("emits a medium needs-approval item", () => {
      const deferredAt = new Date("2026-07-03T00:00:00Z");
      const q = buildExceptionQueue({
        ...base,
        taskNeedsApprovals: [{ taskId: "t1", jobId: "j1", title: "Estimate import", customerName: "Appro Amy", deferredAt }],
      });
      const row = q.items.find((i) => i.kind === "task_needs_approval");
      expect(row).toBeTruthy();
      expect(row!.severity).toBe("medium");
      expect(row!.title).toBe("Appro Amy");
      expect(row!.detail).toBe("Needs approval: Estimate import");
      expect(row!.href).toBe("/jobs/j1");
      expect(row!.occurredAt).toEqual(deferredAt);
      expect(q.counts.task_needs_approval).toBe(1);
    });
  });

  describe("buildExceptionQueue weather_at_risk vector", () => {
    const base = { atRiskJobs: [], overdueInvoices: [], missedAppointments: [], overdueTasks: [], materialDeliveries: [], taskNeedsApprovals: [] };
    it("emits a medium weather item", () => {
      const startsAt = new Date("2026-07-02T16:00:00Z");
      const q = buildExceptionQueue({ ...base, weatherAtRisks: [{ appointmentId: "a1", jobId: "j1", apptType: "crew", startsAt, customerName: "Rainy Rita", note: "Rain 90%" }] });
      const row = q.items.find((i) => i.kind === "weather_at_risk");
      expect(row!.severity).toBe("medium");
      expect(row!.title).toBe("Rainy Rita");
      expect(row!.detail).toBe("Rain 90% — reschedule");
      expect(row!.href).toBe("/schedule");
      expect(row!.occurredAt).toEqual(startsAt);
      expect(q.counts.weather_at_risk).toBe(1);
    });
  });
});
