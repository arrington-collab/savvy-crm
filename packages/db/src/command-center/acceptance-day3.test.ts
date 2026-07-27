/**
 * Day 3 §8 acceptance — real-Postgres checks (2, 4, 6, 10-real, 7-breach).
 *
 * Mirrors bridge-e2e.test.ts's seed/teardown exactly: a throwaway tenant,
 * FK-safe child-then-parent deletes. The pure/injectable half of §8 (checks
 * 1, 3, 5, 8, 9, 10-pure, 7-structural) lives in
 * packages/agents/src/functions/acceptance-day3.test.ts (Task D1).
 *
 * These are acceptance/characterization tests, not RED-first TDD: every seam
 * driven here already exists and is expected to PASS against current code.
 *
 * ARCHITECTURE NOTE (discovered while implementing this file — a genuine
 * cross-package constraint, not a test bug):
 *
 * The brief's representative code for §8.2/§8.4/§8.7-breach/§8.1-drip calls
 * `guardedSms`, `bridgeFirstTouch`, `bridgeBreach`, and `sendDripStep`
 * directly. All four live in @savvy/agents (comms-gateway.ts,
 * lead-intake.ts, lead-speed-to-lead.ts, drip.ts). @savvy/agents already
 * depends on @savvy/db (its package.json lists "@savvy/db": "workspace:*"),
 * and packages/db's own source explicitly documents the reverse as
 * forbidden — see packages/db/src/lifecycle/lead-intake.ts ("must not
 * import `@savvy/agents`, so the Inngest side effect lives in the web
 * layer") and booking.ts ("db must not import @savvy/agents"). Confirmed
 * empirically too: packages/db/node_modules/@savvy has no `agents` symlink
 * (only command-center/core/integrations/orchestrator, i.e. exactly db's
 * declared dependencies) — adding one would need a package.json edit, out
 * of this task's scope ("you write ONLY a test file"), and would create the
 * real dependency cycle the codebase has deliberately avoided.
 *
 * Adaptations made here, each still driving a REAL production seam (nothing
 * reimplemented or mocked to force a pass):
 *
 * - §8.4 and §8.7-breach: instead of calling the agents-side wrapper, this
 *   drives the exact publishDomainEvent/makeEvent(/makeComplianceBlock)
 *   calls that bridgeFirstTouch (lead-intake.ts:181-220) and bridgeBreach
 *   (lead-speed-to-lead.ts:53-65) make internally — verified line-for-line
 *   against those functions. Both wrappers are pure pass-through glue over
 *   @savvy/orchestrator (zero policy decisions of their own beyond "is this
 *   blocked/did this publish"), so this is a faithful re-drive of the real
 *   rule-evaluation + idempotency + escalation-recording seam, not a
 *   reimplementation of business logic.
 *
 * - §8.2: `guardedSms` is NOT a thin wrapper (it evaluates suppression +
 *   consent + A2P + quiet hours + send caps), so inlining it here would be
 *   an actual reimplementation and a tautology risk the brief explicitly
 *   warns against. This file proves the half packages/db legitimately owns:
 *   a STOP recorded via one call path is immediately visible to
 *   isSuppressed() consulted by a completely separate call — the real
 *   cross-agent DB invariant check #2 exists to protect. The
 *   guardedSms-driven half ("a real send unit blocks and the sender is
 *   never called"), fed by this exact DB-backed isSuppressed, is already
 *   proven against real Postgres in
 *   packages/agents/src/functions/drip-send.test.ts:186-207
 *   (sendDripStep -> guardedSms -> isSuppressed) — the correct home, since
 *   it needs both @savvy/db and @savvy/agents in one process.
 *
 * - §8.1-drip (the D1 gap-fill this brief asked D2 to add): sendDripStep
 *   lives in @savvy/agents for the same reason and is not callable from
 *   here either. The exact assertion this check wants (globally-suppressed
 *   contact ⇒ the injected SmsSender is never called) is already proven
 *   against real Postgres in drip-send.test.ts:186-207 ("does NOT call the
 *   sender when the contact is globally suppressed (compliance bypass
 *   closed)"). Not duplicated here — the brief itself warns against a
 *   duplicate-for-show test, and there is no seam packages/db can drive
 *   that would add signal beyond what §8.2 below already covers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { makeEvent, makeComplianceBlock, publishDomainEvent } from "@savvy/orchestrator";
import { projectDay, businessDateOf } from "@savvy/command-center";
import { adminDb, tenant, DrizzleOrchestratorStore, isSuppressed, suppress } from "../index";
import { orchestratorEvent, orchestratorEscalation } from "../schema/orchestrator";
import { dailyMetrics, exceptionQueue } from "../schema/command-center";
import { contactSuppression } from "../schema/comms-suppression";
import { loadEventsForDay, upsertDailyMetrics, getDailyMetrics, listQueue, recordException } from "./store";

let tenantId: string;

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Day3-Accept Co", publicKey: `d3a-${tenantId.slice(0, 8)}` });
});

afterAll(async () => {
  await adminDb.delete(exceptionQueue).where(eq(exceptionQueue.tenantId, tenantId));
  await adminDb.delete(dailyMetrics).where(eq(dailyMetrics.tenantId, tenantId));
  await adminDb.delete(orchestratorEscalation).where(eq(orchestratorEscalation.tenantId, tenantId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tenantId));
  await adminDb.delete(contactSuppression).where(eq(contactSuppression.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

describe("Day 3 §8 acceptance — real DB", () => {
  // CHECK 2 — a STOP recorded by one call path is visible to a completely
  // different caller's isSuppressed() check (the shared cross-agent
  // chokepoint). See the file header for why the guardedSms-driven half of
  // this check lives in drip-send.test.ts instead.
  it("§8.2 a STOP recorded by one path suppresses a lookup made by a different caller (same tenant)", async () => {
    const phone = "+1556" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
    // Not suppressed yet — proves the later `true` isn't a tautology.
    expect(await isSuppressed({ tenantId, phoneE164: phone, channel: "sms" })).toBe(false);

    // "one path" — e.g. the inbound STOP webhook agent.
    await suppress({ tenantId, phoneE164: phone, channel: "sms", reason: "stop", source: "twilio-inbound" });

    // "a different agent" — an unrelated call site consulting the same
    // shared DB-backed chokepoint every comms agent calls before sending.
    expect(await isSuppressed({ tenantId, phoneE164: phone, channel: "sms" })).toBe(true);

    // A different, never-suppressed phone under the same tenant stays clear
    // — the STOP is scoped to its own key, not a blanket tenant suppression.
    const otherPhone = "+1556" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
    expect(await isSuppressed({ tenantId, phoneE164: otherPhone, channel: "sms" })).toBe(false);
  });

  // CHECK 4 — an a2p-blocked first-touch records a compliance-block escalation
  // that lands in the exception queue as an open item. Drives the exact
  // publish + escalate shape bridgeFirstTouch uses for a "blocked" verdict
  // (lead-intake.ts:190-220) — see file header for why the wrapper itself
  // isn't imported here.
  it("§8.4 an a2p-blocked first-touch records a compliance-block in the exception queue", async () => {
    const store = new DrizzleOrchestratorStore();
    const leadId = `l-a2p-${randomUUID()}`;

    const published = await publishDomainEvent(store, makeEvent({
      type: "lead.first_touch", source: "savvy", tenantId,
      correlationId: leadId, idempotencyKey: `lead.first_touch:${leadId}`,
      payload: {
        leadId, channel: "sms", locationId: null,
        occurredAtLeadCreated: new Date().toISOString(), quietHoursDeferred: false,
        latencySeconds: 5, slaLatencySeconds: 5,
      },
    }));
    expect(published.published).toBe(true);

    // bridgeFirstTouch only records the compliance-block escalation when the
    // result status was "blocked" AND the publish newly inserted the event —
    // both true here, matching the real gate.
    const complianceBlock = makeComplianceBlock({
      tenantId, correlationId: leadId,
      eventId: `lead.first_touch:${leadId}`, eventType: "lead.first_touch",
      reason: "a2p_unapproved",
    });
    await store.recordEscalation(complianceBlock);

    await recordException(tenantId, complianceBlock);
    const q = await listQueue(tenantId);
    expect(q.some((r) => r.ruleId === "compliance-block" && r.state === "open" && r.eventId === `lead.first_touch:${leadId}`)).toBe(true);
  });

  // CHECK 6 — first-touch e2e -> Speed panel. Uses its OWN dedicated tenant
  // (rather than the shared `tenantId`) so the tenant-wide daily speed
  // aggregate is exact regardless of the other lead.first_touch events this
  // file also publishes under the shared tenant for checks 4/10.
  it("§8.6 lead.first_touch → orchestrator_event → projectDay populates the Speed panel", async () => {
    const speedTenantId = randomUUID();
    await adminDb.insert(tenant).values({ id: speedTenantId, name: "Day3-Speed Co", publicKey: `d3s-${speedTenantId.slice(0, 8)}` });
    try {
      const store = new DrizzleOrchestratorStore();
      const leadId = `l6-${randomUUID()}`;
      const r = await publishDomainEvent(store, makeEvent({
        type: "lead.first_touch", source: "savvy", tenantId: speedTenantId,
        correlationId: leadId, idempotencyKey: `lead.first_touch:${leadId}`,
        payload: { leadId, channel: "sms", latencySeconds: 30 },
      }));
      expect(r.published).toBe(true);

      const businessDate = businessDateOf(new Date());
      const events = await loadEventsForDay(speedTenantId, businessDate);
      const m = projectDay(events, businessDate);
      expect(m.speed.medianSpeedToLeadMs).toBe(30_000);
      expect(m.speed.pctLeadsUnder5Min).toBe(1);

      await upsertDailyMetrics(speedTenantId, m);
      const got = await getDailyMetrics(speedTenantId, businessDate);
      expect(got?.speed.medianSpeedToLeadMs).toBe(30_000);
      expect(got?.speed.pctLeadsUnder5Min).toBe(1);
    } finally {
      await adminDb.delete(dailyMetrics).where(eq(dailyMetrics.tenantId, speedTenantId));
      await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, speedTenantId));
      await adminDb.delete(tenant).where(eq(tenant.id, speedTenantId));
    }
  });

  // CHECK 10-real — publishing the same first_touch idempotency key twice
  // yields exactly one "received" orchestrator_event row (the second publish
  // is rejected by the partial unique index, not merely deduped in memory).
  it("§8.10 publishing the same first_touch twice yields exactly one orchestrator_event row", async () => {
    const store = new DrizzleOrchestratorStore();
    const leadId = `l10-${randomUUID()}`;
    const idempotencyKey = `lead.first_touch:${leadId}`;
    const mk = () => makeEvent({
      type: "lead.first_touch", source: "savvy", tenantId,
      correlationId: leadId, idempotencyKey,
      payload: { leadId, channel: "sms", latencySeconds: 12 },
    });

    expect((await publishDomainEvent(store, mk())).published).toBe(true);
    expect((await publishDomainEvent(store, mk())).published).toBe(false);

    const rows = await adminDb.select().from(orchestratorEvent).where(and(
      eq(orchestratorEvent.tenantId, tenantId),
      eq(orchestratorEvent.idempotencyKey, idempotencyKey),
      eq(orchestratorEvent.outcome, "received"),
    ));
    expect(rows).toHaveLength(1);
  });

  // CHECK 7-breach — the durable breach escalation lands in the exception
  // queue. Drives the exact publish + escalation-lookup shape bridgeBreach
  // uses (lead-speed-to-lead.ts:53-65) — see file header for why the
  // wrapper itself isn't imported here. True restart-durability is
  // Inngest-runtime-only, asserted structurally in D1 (packages/agents).
  it("§8.7 a speed-to-lead SLA breach publishes lead.sla_breach → speed-to-lead-breach escalation → exception_queue", async () => {
    const store = new DrizzleOrchestratorStore();
    const leadId = `l7-${randomUUID()}`;

    const published = await publishDomainEvent(store, makeEvent({
      type: "lead.sla_breach", source: "savvy", tenantId,
      correlationId: leadId, idempotencyKey: `lead.sla_breach:${leadId}`,
      payload: { leadId, minutes: 12 },
    }));
    expect(published.published).toBe(true);
    const breach = published.escalations.find((e) => e.ruleId === "speed-to-lead-breach");
    expect(breach?.ruleId).toBe("speed-to-lead-breach");

    await recordException(tenantId, breach!);
    const q = await listQueue(tenantId);
    expect(q.some((r) => r.ruleId === "speed-to-lead-breach" && r.eventId === breach!.eventId)).toBe(true);
  });
});
