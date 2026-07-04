import { test, expect, it } from "vitest";
import { buildDigestMessage, buildBreakGlassMessage, buildRecoveryLine, type BreakGlassItem } from "./digest";
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

const bg = (o: Partial<BreakGlassItem>): BreakGlassItem => ({
  taskId: 139, title: "Invoice math", dollarImpactCents: 500_00, ...o,
});

test("break-glass: returns null when there is nothing to page (never page an empty alert)", () => {
  expect(buildBreakGlassMessage([])).toBeNull();
});

test("break-glass: pages count, total dollars, and leads with the biggest-dollar item", () => {
  const msg = buildBreakGlassMessage([
    bg({ title: "Small", dollarImpactCents: 200_00 }),
    bg({ title: "Huge", dollarImpactCents: 1_800_00 }),
  ]);
  expect(msg).not.toBeNull();
  expect(msg!.count).toBe(2);
  expect(msg!.totalDollars).toBe(2000); // (200_00 + 1_800_00) / 100
  expect(msg!.body).toContain("2");
  expect(msg!.body).toContain("Huge"); // ranked by dollar impact, biggest leads
  expect(msg!.body).toContain("$2,000");
});

test("break-glass: uses singular phrasing for one item", () => {
  const msg = buildBreakGlassMessage([bg({ dollarImpactCents: 750_00 })]);
  expect(msg!.count).toBe(1);
  expect(msg!.totalDollars).toBe(750);
  expect(msg!.body).toMatch(/1 break-glass issue/);
});

it("renders recovered + pending recovery dollars, null when both zero", () => {
  expect(buildRecoveryLine({ recoveredCents: 30000, pendingCents: 45000 })).toBe("💰 Recovered $300.00 this period · $450.00 pending");
  expect(buildRecoveryLine({ recoveredCents: 0, pendingCents: 0 })).toBeNull();
});
