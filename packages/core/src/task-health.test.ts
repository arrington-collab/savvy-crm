import { test, expect } from "vitest";
import { computeTaskHealth, type TaskHealthInputs } from "./task-health";

// A passing, well-established task as the baseline; each test overrides fields.
const base: TaskHealthInputs = {
  mode: "full_auto",
  hasCheckKey: true,
  priorStatus: "amber",
  priorStreakDays: 0,
  latestVerification: "pass",
  consecutiveFails: 0,
  doneButWrong: false,
  openExceptionCount: 0,
  openExceptionPastSla: false,
};
const c = (o: Partial<TaskHealthInputs>) => computeTaskHealth({ ...base, ...o });

test("gray when the task is manual or has no check (not measured)", () => {
  expect(c({ mode: "manual" }).status).toBe("gray");
  expect(c({ hasCheckKey: false }).status).toBe("gray");
});

test("green is EARNED at a 14-day clean streak, not before", () => {
  expect(c({ priorStreakDays: 12 }).status).toBe("amber"); // -> 13, still warming up
  expect(c({ priorStreakDays: 12 }).cleanStreakDays).toBe(13);
  expect(c({ priorStreakDays: 13 }).status).toBe("green"); // -> 14, earned
  expect(c({ priorStreakDays: 13 }).cleanStreakDays).toBe(14);
  expect(c({ priorStreakDays: 30 }).status).toBe("green");
});

test("a passing sweep increments the streak; any non-clean sweep resets it to 0", () => {
  expect(c({ priorStreakDays: 5 }).cleanStreakDays).toBe(6);
  expect(c({ priorStreakDays: 5, latestVerification: "fail", consecutiveFails: 1 }).cleanStreakDays).toBe(0);
  expect(c({ priorStreakDays: 5, latestVerification: "stale" }).cleanStreakDays).toBe(0);
});

test("amber on a single fail; red on two consecutive fails", () => {
  expect(c({ latestVerification: "fail", consecutiveFails: 1 }).status).toBe("amber");
  expect(c({ latestVerification: "fail", consecutiveFails: 2 }).status).toBe("red");
});

test("red on done-but-wrong even if the invariant itself passed", () => {
  expect(c({ latestVerification: "pass", doneButWrong: true }).status).toBe("red");
  expect(c({ latestVerification: "pass", doneButWrong: true }).cleanStreakDays).toBe(0);
});

test("amber when the verification is stale (a vendor/timeout soft-fail)", () => {
  expect(c({ latestVerification: "stale" }).status).toBe("amber");
});

test("a clean skip is neutral — carries prior status and streak, no regression", () => {
  const r = c({ latestVerification: "skip", priorStatus: "green", priorStreakDays: 20 });
  expect(r.status).toBe("green");
  expect(r.cleanStreakDays).toBe(20);
  expect(r.emitsRegression).toBe(false);
});

test("an open exception blocks green (amber) even at a long streak", () => {
  expect(c({ priorStreakDays: 30, openExceptionCount: 1 }).status).toBe("amber");
  expect(c({ priorStreakDays: 30, openExceptionPastSla: true }).status).toBe("amber");
});

test("a task that has never verified is amber (unproven), not green or gray", () => {
  expect(c({ latestVerification: null, priorStreakDays: 0 }).status).toBe("amber");
});

test("emitsRegression only on green -> amber/red, never on recovery or green->gray", () => {
  expect(c({ priorStatus: "green", latestVerification: "fail", consecutiveFails: 1 }).emitsRegression).toBe(true);
  expect(c({ priorStatus: "green", doneButWrong: true }).emitsRegression).toBe(true); // -> red
  expect(c({ priorStatus: "amber", priorStreakDays: 13 }).emitsRegression).toBe(false); // amber -> green
  expect(c({ priorStatus: "green", mode: "manual" }).emitsRegression).toBe(false); // -> gray, not a regression
});
