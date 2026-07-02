import { test, expect } from "vitest";
import { buildTaskExceptions, type TaskExceptionInput } from "./task-exception";

const base: TaskExceptionInput = {
  taskId: 1, taskName: "Task", status: "red", latestVerification: "fail",
  ledgerExceptionCount: 0, estFounderMinutes: 10,
};
const one = (o: Partial<TaskExceptionInput>) => buildTaskExceptions([{ ...base, ...o }]);

test("only amber/red tasks produce exceptions (green/gray never do)", () => {
  expect(one({ status: "green" })).toEqual([]);
  expect(one({ status: "gray" })).toEqual([]);
  expect(one({ status: "amber" })).toHaveLength(1);
  expect(one({ status: "red" })).toHaveLength(1);
});

test("done-but-wrong (ledger exceptions) classifies as high-severity verification_mismatch", () => {
  const [e] = one({ status: "red", ledgerExceptionCount: 2 });
  expect(e!.kind).toBe("verification_mismatch");
  expect(e!.severity).toBe("high");
});

test("a stale verification classifies as task_stale", () => {
  const [e] = one({ status: "amber", latestVerification: "stale", ledgerExceptionCount: 0 });
  expect(e!.kind).toBe("task_stale");
  expect(e!.severity).toBe("medium");
});

test("an otherwise-unhealthy task is a task_regression (red=high, amber=medium)", () => {
  expect(one({ status: "red", latestVerification: "fail", ledgerExceptionCount: 0 })[0]!.kind).toBe("task_regression");
  expect(one({ status: "red" })[0]!.severity).toBe("high");
  expect(one({ status: "amber", latestVerification: "fail" })[0]!.severity).toBe("medium");
});

test("ranks high severity first, then by est_founder_minutes descending", () => {
  const items = buildTaskExceptions([
    { ...base, taskId: 1, status: "amber", latestVerification: "fail", estFounderMinutes: 5 }, // medium
    { ...base, taskId: 2, status: "red", ledgerExceptionCount: 1, estFounderMinutes: 3 }, // high
    { ...base, taskId: 3, status: "red", ledgerExceptionCount: 1, estFounderMinutes: 40 }, // high, bigger burden
  ]);
  expect(items.map((e) => e.taskId)).toEqual([3, 2, 1]); // high(40) > high(3) > medium
});
