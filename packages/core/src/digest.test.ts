import { test, expect } from "vitest";
import { buildDigestMessage } from "./digest";
import type { TaskException } from "./task-exception";

const ex = (o: Partial<TaskException>): TaskException => ({
  taskId: 1, kind: "task_regression", severity: "high", title: "T", detail: "d", estFounderMinutes: 10, ...o,
});

test("returns null when there are no exceptions (never send an empty digest)", () => {
  expect(buildDigestMessage([])).toBeNull();
});

test("summarizes count, the top item, and total founder-minutes", () => {
  const msg = buildDigestMessage([
    ex({ title: "Invoice math", detail: "1 done-but-wrong", estFounderMinutes: 20 }),
    ex({ title: "Dedupe", estFounderMinutes: 5 }),
  ]);
  expect(msg).not.toBeNull();
  expect(msg!.count).toBe(2);
  expect(msg!.totalMinutes).toBe(25);
  expect(msg!.body).toContain("2 tasks");
  expect(msg!.body).toContain("Invoice math"); // the highest-priority item leads
  expect(msg!.body).toContain("25 min");
});

test("uses singular phrasing for a single exception", () => {
  expect(buildDigestMessage([ex({})])!.body).toMatch(/^1 task needs/);
});
