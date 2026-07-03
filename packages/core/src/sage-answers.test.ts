import { test, expect } from "vitest";
import { buildJobLedgerAnswers, buildTaskHealthAnswer, type LedgerLite, type TaskHealthLite } from "./sage-answers";

const row = (o: Partial<LedgerLite>): LedgerLite => ({ taskId: 1, name: "Task", status: "pending", evidence: null, ...o });

test("job ledger: empty job says nothing is instantiated, no done-but-wrong question", () => {
  const a = buildJobLedgerAnswers("job-1", []);
  expect(a[0]!.answer.toLowerCase()).toContain("no ledger");
  expect(a.some((x) => x.q.toLowerCase().includes("done-but-wrong"))).toBe(false);
});

test("job ledger: cites counts, lists what's open, and flags done-but-wrong with evidence", () => {
  const a = buildJobLedgerAnswers("job-1", [
    row({ taskId: 139, name: "Invoice generation", status: "exception", evidence: { type: "invoice", ref: "inv-1" } }),
    row({ taskId: 25, name: "Booking", status: "verified" }),
    row({ taskId: 56, name: "Estimate", status: "done" }),
  ]);
  // Q1 cites counts (verified / total)
  expect(a[0]!.answer).toContain("1 of 3");
  expect(a[0]!.actions?.[0]!.href).toBe("/jobs/job-1");
  // Q2 lists the open work (not the verified one)
  const whatsLeft = a.find((x) => x.q.toLowerCase().includes("left"))!;
  expect(whatsLeft.answer).toContain("Invoice generation");
  expect(whatsLeft.answer).toContain("Estimate");
  expect(whatsLeft.answer).not.toContain("Booking");
  // Q3 flags done-but-wrong, cites evidence, links to the task
  const wrong = a.find((x) => x.q.toLowerCase().includes("done-but-wrong"))!;
  expect(wrong.answer).toContain("invoice:inv-1");
  expect(wrong.actions?.[0]!.href).toBe("/tasks/139");
});

test("job ledger: all verified reads as nothing left", () => {
  const a = buildJobLedgerAnswers("job-1", [row({ status: "verified" }), row({ taskId: 2, status: "verified" })]);
  const whatsLeft = a.find((x) => x.q.toLowerCase().includes("left"))!;
  expect(whatsLeft.answer.toLowerCase()).toContain("nothing left");
  expect(a.some((x) => x.q.toLowerCase().includes("done-but-wrong"))).toBe(false);
});

const th = (o: Partial<TaskHealthLite> = {}): TaskHealthLite => ({ taskId: 139, name: "Invoice generation", healthStatus: "green", latestVerification: "pass", exception: null, ...o });

test("task health: healthy task cites status and last check", () => {
  const [a] = buildTaskHealthAnswer(th());
  expect(a!.q).toContain("Invoice generation");
  expect(a!.answer).toContain("green");
  expect(a!.answer).toContain("pass");
  expect(a!.actions?.[0]!.href).toBe("/tasks/139");
});

test("task health: flagged task cites the open exception", () => {
  const [a] = buildTaskHealthAnswer(th({ healthStatus: "red", latestVerification: "fail", exception: { kind: "verification_mismatch", severity: "high" } }));
  expect(a!.answer).toContain("red");
  expect(a!.answer).toContain("verification_mismatch");
  expect(a!.answer).toContain("high");
});

test("task health: unscored task says so", () => {
  const [a] = buildTaskHealthAnswer(th({ healthStatus: null, latestVerification: null }));
  expect(a!.answer.toLowerCase()).toContain("unscored");
});
