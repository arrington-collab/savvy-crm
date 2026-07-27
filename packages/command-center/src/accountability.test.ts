import { describe, it, expect } from "vitest";
import { ageBucketFor, groupActiveByOwnerAndAge } from "./accountability";
import type { QueueItem, QueueState } from "./exception-queue";

const NOW = new Date("2026-07-27T12:00:00Z");

function item(overrides: Partial<QueueItem> & { key: string }): QueueItem {
  return {
    ruleId: "rule", eventId: "evt", severity: "high", reason: "test",
    notify: ["arrington"], assignee: "arrington", state: "open" as QueueState,
    acknowledgedAt: null, resolvedAt: null, resolutionNote: null, snoozeUntil: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("ageBucketFor", () => {
  it("buckets fresh items into 0-1d", () => {
    expect(ageBucketFor(daysAgo(0), NOW)).toBe("0-1d");
    expect(ageBucketFor(daysAgo(1), NOW)).toBe("0-1d");
  });

  it("buckets by ascending age thresholds", () => {
    expect(ageBucketFor(daysAgo(2), NOW)).toBe("2-3d");
    expect(ageBucketFor(daysAgo(3), NOW)).toBe("2-3d");
    expect(ageBucketFor(daysAgo(4), NOW)).toBe("4-7d");
    expect(ageBucketFor(daysAgo(7), NOW)).toBe("4-7d");
  });

  it("catches anything past the last threshold in the 8d+ bucket", () => {
    expect(ageBucketFor(daysAgo(8), NOW)).toBe("8d+");
    expect(ageBucketFor(daysAgo(90), NOW)).toBe("8d+");
  });
});

describe("groupActiveByOwnerAndAge", () => {
  it("groups by assignee (owner), not by notify membership", () => {
    const items = [
      item({ key: "a", assignee: "arrington", notify: ["sales-manager", "arrington"] }),
      item({ key: "b", assignee: "sales-manager", notify: ["sales-manager", "arrington"] }),
    ];
    const groups = groupActiveByOwnerAndAge(items, NOW);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.owner === "arrington")!.total).toBe(1);
    expect(groups.find((g) => g.owner === "sales-manager")!.total).toBe(1);
  });

  it("excludes acknowledged/resolved items and future-snoozed items (reuses isActive, doesn't reinvent it)", () => {
    const items = [
      item({ key: "open", state: "open" }),
      item({ key: "acked", state: "acknowledged" }),
      item({ key: "resolved", state: "resolved" }),
      item({ key: "snoozed-future", state: "snoozed", snoozeUntil: new Date(NOW.getTime() + 86_400_000).toISOString() }),
      item({ key: "snoozed-due", state: "snoozed", snoozeUntil: new Date(NOW.getTime() - 1000).toISOString() }),
    ];
    const groups = groupActiveByOwnerAndAge(items, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.total).toBe(2); // open + snoozed-due
  });

  it("buckets each owner's active items by age", () => {
    const items = [
      item({ key: "fresh", assignee: "arrington", createdAt: daysAgo(0) }),
      item({ key: "aging", assignee: "arrington", createdAt: daysAgo(5) }),
      item({ key: "stale", assignee: "arrington", createdAt: daysAgo(10) }),
    ];
    const [group] = groupActiveByOwnerAndAge(items, NOW);
    expect(group!.byAge["0-1d"]).toHaveLength(1);
    expect(group!.byAge["4-7d"]).toHaveLength(1);
    expect(group!.byAge["8d+"]).toHaveLength(1);
    expect(group!.oldestDays).toBeGreaterThanOrEqual(10);
  });

  it("sorts owners worst-aging-first, so the most-neglected plate leads the panel", () => {
    const items = [
      item({ key: "a", assignee: "fresh-owner", createdAt: daysAgo(0) }),
      item({ key: "b", assignee: "stale-owner", createdAt: daysAgo(20) }),
    ];
    const groups = groupActiveByOwnerAndAge(items, NOW);
    expect(groups[0]!.owner).toBe("stale-owner");
    expect(groups[1]!.owner).toBe("fresh-owner");
  });

  it("returns an empty array for a no-exceptions tenant, no crash", () => {
    expect(groupActiveByOwnerAndAge([], NOW)).toEqual([]);
  });
});
