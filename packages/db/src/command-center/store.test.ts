import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeEvent } from "@savvy/orchestrator";
import { projectDay } from "@savvy/command-center";
import type { QueueItem } from "@savvy/command-center";
import { adminDb, tenant } from "../index";
import { orchestratorEvent } from "../schema/orchestrator";
import { dailyMetrics, exceptionQueue } from "../schema/command-center";
import { loadEventsForDay, upsertDailyMetrics, getDailyMetrics, upsertQueueItem, listQueue } from "./store";

let tenantId: string;
const D = "2026-07-01";
const at = (h: number) => new Date(Date.UTC(2026, 6, 1, 6 + h)).toISOString();

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "CC-Test", publicKey: `cc-${tenantId.slice(0, 8)}` });
  // seed 2 received events on day D
  for (const [i, src] of [["l1", "web"], ["l2", "canvass"]].entries()) {
    const e = makeEvent({ type: "lead.created", source: "savvy", tenantId, correlationId: "c", idempotencyKey: `k${i}`, occurredAt: at(1), payload: { leadId: src[0], customerId: "c", source: src[1] } } as never);
    // orchestrator_event has no occurred_at column; loadEventsForDay windows on
    // created_at (write time), so the seed must set it explicitly into day D's
    // Denver window — leaving it to defaultNow() would land the row on today's
    // actual date, not D.
    await adminDb.insert(orchestratorEvent).values({ tenantId, eventId: e.id, eventType: e.type, version: e.version, source: e.source, correlationId: e.correlationId, idempotencyKey: e.idempotencyKey, agent: "system", outcome: "received", emitted: [], payload: e.payload as Record<string, unknown>, createdAt: new Date(at(1)) });
  }
});
afterAll(async () => {
  await adminDb.delete(exceptionQueue).where(eq(exceptionQueue.tenantId, tenantId));
  await adminDb.delete(dailyMetrics).where(eq(dailyMetrics.tenantId, tenantId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("loadEventsForDay returns the day's received events; projectDay folds them", async () => {
  const log = await loadEventsForDay(tenantId, D);
  expect(log).toHaveLength(2);
  const m = projectDay(log, D);
  expect(m.topLine.leadsTotal).toBe(2);
  expect(m.topLine.leadsBySource).toEqual({ web: 1, canvass: 1 });
});

it("upsert/getDailyMetrics round-trips and is idempotent by date", async () => {
  const m = projectDay(await loadEventsForDay(tenantId, D), D);
  await upsertDailyMetrics(tenantId, m);
  await upsertDailyMetrics(tenantId, m); // second upsert must not duplicate
  const rows = await adminDb.select().from(dailyMetrics).where(eq(dailyMetrics.tenantId, tenantId));
  expect(rows).toHaveLength(1);
  const got = await getDailyMetrics(tenantId, D);
  expect(got?.topLine.leadsTotal).toBe(2);
});

it("upsertQueueItem/listQueue round-trips with eventId/ruleId intact; re-upsert updates not duplicates", async () => {
  const item: QueueItem = {
    key: "low-margin:evt-1", ruleId: "low-margin", eventId: "evt-1",
    severity: "high", reason: "18% margin", notify: ["arrington"], assignee: "arrington",
    state: "open", acknowledgedAt: null, resolvedAt: null, resolutionNote: null, snoozeUntil: null,
    createdAt: at(2),
  };
  await upsertQueueItem(tenantId, item);
  await upsertQueueItem(tenantId, { ...item, state: "acknowledged", assignee: "scott" });

  const rows = await adminDb.select().from(exceptionQueue).where(eq(exceptionQueue.tenantId, tenantId));
  expect(rows).toHaveLength(1); // second upsert updated, did not duplicate

  const list = await listQueue(tenantId);
  expect(list).toHaveLength(1);
  const got = list[0]!;
  expect(got.key).toBe("low-margin:evt-1");
  expect(got.ruleId).toBe("low-margin");
  expect(got.eventId).toBe("evt-1");
  expect(got.state).toBe("acknowledged");
  expect(got.assignee).toBe("scott");
  expect((got as never as Record<string, unknown>)["escalationId"]).toBeUndefined();
  expect((got as never as Record<string, unknown>)["idempotencyKey"]).toBeUndefined();
});
