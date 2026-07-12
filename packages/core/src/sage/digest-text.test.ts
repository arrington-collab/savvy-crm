import { describe, it, expect } from "vitest";
import { buildSageDigestText, actionVerb, describeSageItem } from "./digest-text";
import type { SageDigestItem } from "./types";

const estimate: SageDigestItem = {
  kind: "estimate_approval",
  entityId: "est1",
  jobId: "job1",
  title: "Kowalski",
  detail: "estimate $32.7k @ 41% GM",
  action: "approve_estimate",
  confirmAmountCents: 3270000,
};

const overdue: SageDigestItem = {
  kind: "invoice_overdue",
  entityId: "inv1",
  jobId: "job2",
  title: "Yates",
  detail: "60d overdue · $8,400",
  action: "send_invoice",
  confirmAmountCents: 840000,
};

const photo: SageDigestItem = {
  kind: "photo_quality",
  entityId: "doc1",
  jobId: "job3",
  title: "Photo needs attention",
  detail: "blurry ridge shot",
  action: null,
  confirmAmountCents: null,
};

describe("actionVerb", () => {
  it("maps each action kind to an imperative verb", () => {
    expect(actionVerb("approve_estimate")).toBe("approve");
    expect(actionVerb("send_invoice")).toBe("send");
    expect(actionVerb("complete_task")).toBe("complete");
    expect(actionVerb("send_credit")).toBe("send credit request");
  });
});

describe("buildSageDigestText", () => {
  it("returns an empty body for no items", () => {
    expect(buildSageDigestText([])).toEqual({ body: "", count: 0 });
  });

  it("numbers actionable items with a reply-to-act suffix", () => {
    const { body, count } = buildSageDigestText([estimate, overdue]);
    expect(count).toBe(2);
    expect(body).toContain("Savvy: 2 to act");
    expect(body).toContain("(1) Kowalski — estimate $32.7k @ 41% GM — reply 1 to approve");
    expect(body).toContain("(2) Yates — 60d overdue · $8,400 — reply 2 to send");
  });

  it("routes a non-actionable item to a detail reply", () => {
    const { body } = buildSageDigestText([estimate, photo]);
    expect(body).toContain("(2) Photo needs attention — blurry ridge shot — reply 2 for detail");
  });
});

describe("describeSageItem", () => {
  it("includes the title, detail, and a deep link when a job is present", () => {
    expect(describeSageItem(estimate, 1)).toBe("(1) Kowalski — estimate $32.7k @ 41% GM · /jobs/job1");
  });

  it("omits the deep link when there is no job", () => {
    const noJob: SageDigestItem = { ...photo, jobId: null };
    expect(describeSageItem(noJob, 4)).toBe("(4) Photo needs attention — blurry ridge shot");
  });
});
