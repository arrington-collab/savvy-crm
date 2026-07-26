import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeEvent, publishDomainEvent } from "@savvy/orchestrator";
import { projectDay, businessDateOf } from "@savvy/command-center";
import { adminDb, tenant, DrizzleOrchestratorStore } from "../index";
import { orchestratorEvent, orchestratorEscalation } from "../schema/orchestrator";
import { dailyMetrics, exceptionQueue } from "../schema/command-center";
import { loadEventsForDay, upsertDailyMetrics, getDailyMetrics, listQueue, recordException } from "./store";

// Slice B gate (Task B10): proves the whole bridge chain end-to-end against a
// real Postgres, not mocks: publishDomainEvent -> orchestrator_event ->
// loadEventsForDay/projectDay -> daily_metrics, and separately
// publishDomainEvent(escalating event) -> recordException -> exception_queue.
// Mirrors the seeding/teardown of orchestrator/integration.test.ts and
// command-center/store.test.ts.

let tenantId: string;
// "Today" in the Denver business day — publishDomainEvent's insertEventIfNew
// stamps created_at = now() (no occurred_at column on orchestrator_event, see
// read.ts), so the row lands in *today's* Denver window automatically. Using
// the real current business date (rather than a fixed day like store.test.ts's
// D) is what makes this an honest "today" end-to-end proof.
const businessDate = businessDateOf(new Date());

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Bridge-E2E Co", publicKey: `be-${tenantId.slice(0, 8)}` });
});

afterAll(async () => {
  await adminDb.delete(exceptionQueue).where(eq(exceptionQueue.tenantId, tenantId));
  await adminDb.delete(dailyMetrics).where(eq(dailyMetrics.tenantId, tenantId));
  await adminDb.delete(orchestratorEscalation).where(eq(orchestratorEscalation.tenantId, tenantId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("event -> orchestrator_event -> read model -> daily_metrics round-trips a within-SLA first touch", async () => {
  const store = new DrizzleOrchestratorStore();
  const leadId = `l-${randomUUID()}`;

  const result = await publishDomainEvent(store, makeEvent({
    type: "lead.first_touch",
    source: "savvy",
    tenantId,
    correlationId: leadId,
    idempotencyKey: `lead.first_touch:${leadId}`,
    payload: { leadId, channel: "sms", latencySeconds: 30 },
  }));
  expect(result.published).toBe(true);

  const events = await loadEventsForDay(tenantId, businessDate);
  expect(events).toHaveLength(1);
  expect(events[0]!.type).toBe("lead.first_touch");

  const metrics = projectDay(events, businessDate);
  // one lead, first-touch latency 30s -> well within the 5-minute SLA.
  expect(metrics.speed.medianSpeedToLeadMs).toBe(30_000);
  expect(metrics.speed.pctLeadsUnder5Min).toBe(1);

  await upsertDailyMetrics(tenantId, metrics);
  const got = await getDailyMetrics(tenantId, businessDate);
  expect(got?.speed.medianSpeedToLeadMs).toBe(30_000);
  expect(got?.speed.pctLeadsUnder5Min).toBe(1);
});

it("an escalating event -> orchestrator_escalation -> recordException -> exception_queue open item", async () => {
  const store = new DrizzleOrchestratorStore();
  const leadId = `l-${randomUUID()}`;

  const result = await publishDomainEvent(store, makeEvent({
    type: "lead.sla_breach",
    source: "savvy",
    tenantId,
    correlationId: leadId,
    idempotencyKey: `lead.sla_breach:${leadId}`,
    payload: { leadId, minutes: 12 },
  }));
  expect(result.published).toBe(true);
  const breach = result.escalations.find((e) => e.ruleId === "speed-to-lead-breach");
  expect(breach).toBeDefined();

  await recordException(tenantId, breach!);

  const queue = await listQueue(tenantId);
  const item = queue.find((q) => q.key === `speed-to-lead-breach:${breach!.eventId}`);
  expect(item).toBeDefined();
  expect(item?.ruleId).toBe("speed-to-lead-breach");
  expect(item?.state).toBe("open");
});
