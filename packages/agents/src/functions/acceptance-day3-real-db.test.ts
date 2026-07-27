import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminDb, adminPool, pool, eq,
  tenant, DrizzleOrchestratorStore, recordException, listQueue, suppress, isSuppressed,
  orchestratorEvent, orchestratorEscalation, exceptionQueue, contactSuppression,
} from "@savvy/db";
import { bridgeFirstTouch } from "./lead-intake";
import { bridgeBreach } from "./lead-speed-to-lead";
import { guardedSms } from "../comms-gateway";

// Day 3 Slice D §8 acceptance — the literal gap the final Slice D2 review
// flagged: packages/db/src/command-center/acceptance-day3.test.ts could NOT
// import @savvy/agents, so it re-drove publishDomainEvent/makeComplianceBlock
// directly instead of calling the REAL bridgeFirstTouch/bridgeBreach/guardedSms
// functions. That proved the plumbing (orchestrator_event -> exception_queue)
// but never proved those functions themselves wire it correctly against a real
// store — only InMemoryStore was ever exercised (lead-intake-bridge.test.ts,
// lead-speed-to-lead.test.ts, comms-gateway.test.ts). packages/agents CAN
// import DrizzleOrchestratorStore from @savvy/db (agents -> db is allowed), so
// this file drives the real functions with the real Drizzle-backed store.
let tId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({
    name: "Day3-Accept-RealDB", publicKey: `d3a-${randomUUID().slice(0, 8)}`,
  }).returning();
  tId = t!.id;
});

afterAll(async () => {
  // FK-safe order: exception_queue and orchestrator_escalation/orchestrator_event
  // and contact_suppression all reference tenant, so they go first.
  await adminDb.delete(exceptionQueue).where(eq(exceptionQueue.tenantId, tId));
  await adminDb.delete(orchestratorEscalation).where(eq(orchestratorEscalation.tenantId, tId));
  await adminDb.delete(orchestratorEvent).where(eq(orchestratorEvent.tenantId, tId));
  await adminDb.delete(contactSuppression).where(eq(contactSuppression.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("Day 3 §8 acceptance — real agent functions × real Postgres", () => {
  it("§8.4-literal: bridgeFirstTouch(blocked) records a compliance-block in exception_queue, and is idempotent on a duplicate delivery for the same leadId (published-gate)", async () => {
    const leadId = `l-${randomUUID()}`;
    const key = `compliance-block:lead.first_touch:${leadId}`;
    const blockedVerdict = { status: "blocked" as const, reason: "a2p_unapproved" as const };

    // First delivery: a genuinely new lead.first_touch event -> published=true
    // -> compliance-block escalation built and returned.
    const first = await bridgeFirstTouch(new DrizzleOrchestratorStore(), {
      tenantId: tId, leadId, latencySeconds: 5,
      occurredAtLeadCreated: new Date().toISOString(),
      result: blockedVerdict,
    });
    expect(first.complianceBlock?.ruleId).toBe("compliance-block");
    await recordException(tId, first.complianceBlock!);

    const afterFirst = (await listQueue(tId)).filter((q) => q.key === key);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.ruleId).toBe("compliance-block");
    expect(afterFirst[0]!.state).toBe("open");

    // Second delivery: SAME leadId + SAME blocked verdict (e.g. an Inngest
    // step retry re-running bridge-first-touch). The real DrizzleOrchestratorStore
    // enforces the (tenantId, idempotencyKey) unique index on lead.first_touch,
    // so insertEventIfNew's 2nd insert conflicts and publishDomainEvent reports
    // published:false. bridgeFirstTouch's `if (published.published && ...)`
    // gate must therefore skip building a 2nd compliance-block entirely — this
    // is the exact policy the review flagged as untested against a real store.
    const second = await bridgeFirstTouch(new DrizzleOrchestratorStore(), {
      tenantId: tId, leadId, latencySeconds: 5,
      occurredAtLeadCreated: new Date().toISOString(),
      result: blockedVerdict,
    });
    expect(second.complianceBlock).toBeUndefined();
    // Defensive: if this ever regresses and DOES return a 2nd escalation, still
    // record it so the queue-count assertion below fails loudly on the real bug
    // (a real double-record) rather than silently passing on a skipped call.
    if (second.complianceBlock) await recordException(tId, second.complianceBlock);

    const afterSecond = (await listQueue(tId)).filter((q) => q.key === key);
    expect(afterSecond).toHaveLength(1);
  });

  it("§8.7-breach-literal: bridgeBreach publishes lead.sla_breach and records a speed-to-lead-breach escalation in exception_queue", async () => {
    const leadId = `l-${randomUUID()}`;

    const { breach } = await bridgeBreach(new DrizzleOrchestratorStore(), {
      tenantId: tId, leadId, minutes: 12,
    });
    expect(breach?.ruleId).toBe("speed-to-lead-breach");
    await recordException(tId, breach!);

    const queue = await listQueue(tId);
    const item = queue.find((q) => q.key === `speed-to-lead-breach:${breach!.eventId}`);
    expect(item).toBeDefined();
    expect(item?.ruleId).toBe("speed-to-lead-breach");
    expect(item?.state).toBe("open");
  });

  // §8.1 (drip's suppressed-blocked path against real Postgres) is already
  // proven end-to-end in drip-send.test.ts:186-207 ("does NOT call the sender
  // when the contact is globally suppressed") — not duplicated here.
  it("§8.2-guarded-literal: guardedSms blocks a globally-suppressed contact using the real DB-backed isSuppressed (cross-agent STOP -> different-agent blocked)", async () => {
    const phone = `+1555555${Math.floor(1000 + Math.random() * 8999)}`;
    await suppress({ tenantId: tId, phoneE164: phone, channel: "sms", reason: "stop", source: "twilio-inbound" });

    const sendSms = vi.fn();
    const res = await guardedSms(
      { isSuppressed, sms: { sendSms }, smsFrom: () => "+15550000000" },
      {
        tenantId: tId, channel: "sms", to: phone, body: "x",
        consent: { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date() },
        a2pApproved: true,
      },
    );
    expect(res).toEqual({ status: "blocked", reason: "suppressed" });
    expect(sendSms).not.toHaveBeenCalled();
  });
});
