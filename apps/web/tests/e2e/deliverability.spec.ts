/**
 * e2e: SMS delivery webhook → communication.delivery_status (Test A)
 * and unregistered A2P 10DLC ⇒ comms.deliverability break-glass exception (Test B).
 *
 * Both tests use their own isolated tenants so there is no shared-state coupling.
 *
 * Test B exercises the real reconcileTaskExceptions pipeline at the DB/lifecycle
 * layer rather than through Inngest (the Inngest sweep is async and cannot be
 * reliably awaited in a short e2e window). The break-glass assertion covers the
 * same code path that sweepTenantHealth drives in production:
 *   failing verificationRun → recomputeTaskHealth (amber) →
 *   reconcileTaskExceptions → task_exception{break_glass=true, severity="high"}.
 */
import { test, expect, request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  adminDb,
  eq,
  isNull,
  and,
  tenant,
  communication,
  taskRegistry,
  tenantTaskConfig,
  verificationRun,
  taskException,
  taskHealth,
  recomputeTaskHealth,
  reconcileTaskExceptions,
} from "@savvy/db";

// ---------------------------------------------------------------------------
// Test A: Twilio StatusCallback webhook writes communication.delivery_status
// ---------------------------------------------------------------------------
test("delivery webhook: updates delivery_status and delivery_error_code on communication", async ({ baseURL }) => {
  const stamp = randomUUID().slice(0, 8);
  const tenantId = randomUUID();

  // Two distinct Twilio SIDs: one for the "delivered" path, one for "failed+error"
  const sidOk = `SM${stamp}ok`;
  const sidErr = `SM${stamp}er`;

  // Seed isolated tenant (no Twilio connection needed — webhook is SID-keyed)
  await adminDb.insert(tenant).values({
    id: tenantId,
    name: `Delivery Test ${stamp}`,
    publicKey: `dt-${stamp}`,
    clerkOrgId: `org-dt-${stamp}`,
    settings: {},
  });

  // Seed two outbound SMS rows with known twilio_sid values
  const [rowOk] = await adminDb
    .insert(communication)
    .values({
      tenantId,
      channel: "sms",
      direction: "outbound",
      twilioSid: sidOk,
      body: "Appointment confirmed",
      to: "+15555550001",
    })
    .returning({ id: communication.id });

  const [rowErr] = await adminDb
    .insert(communication)
    .values({
      tenantId,
      channel: "sms",
      direction: "outbound",
      twilioSid: sidErr,
      body: "Follow-up message",
      to: "+15555550002",
    })
    .returning({ id: communication.id });

  try {
    const api = await request.newContext();

    // ---- Part 1: MessageStatus=delivered ----
    const res1 = await api.post(`${baseURL}/api/twilio/status`, {
      form: {
        MessageSid: sidOk,
        MessageStatus: "delivered",
      },
    });
    expect(res1.status()).toBe(200);

    // Assert delivery_status was written; no error code
    const [after1] = await adminDb
      .select({
        deliveryStatus: communication.deliveryStatus,
        deliveryErrorCode: communication.deliveryErrorCode,
      })
      .from(communication)
      .where(eq(communication.id, rowOk!.id));
    expect(after1!.deliveryStatus).toBe("delivered");
    expect(after1!.deliveryErrorCode).toBeNull();

    // ---- Part 2: MessageStatus=failed + ErrorCode=30007 (spam/carrier filter) ----
    const res2 = await api.post(`${baseURL}/api/twilio/status`, {
      form: {
        MessageSid: sidErr,
        MessageStatus: "failed",
        ErrorCode: "30007",
      },
    });
    expect(res2.status()).toBe(200);

    // Assert both delivery_status and delivery_error_code were written
    const [after2] = await adminDb
      .select({
        deliveryStatus: communication.deliveryStatus,
        deliveryErrorCode: communication.deliveryErrorCode,
      })
      .from(communication)
      .where(eq(communication.id, rowErr!.id));
    expect(after2!.deliveryStatus).toBe("failed");
    expect(after2!.deliveryErrorCode).toBe("30007");
  } finally {
    // Teardown: communication rows first (FK → tenant), then tenant
    await adminDb.delete(communication).where(eq(communication.tenantId, tenantId));
    await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  }
});

// ---------------------------------------------------------------------------
// Test B: tenant with no Twilio connection ⇒ comms.deliverability break-glass
//
// Pipeline under test (same code path as sweepTenantHealth):
//   1. Look up the comms.deliverability registry task (skip if not seeded)
//   2. Seed tenant with NO integration_connection (getA2pRegistration → registered:false)
//   3. Seed tenantTaskConfig enabling the task in full_auto mode
//   4. Seed a failing verificationRun (simulates the check result)
//   5. recomputeTaskHealth → taskHealth.status = "amber"
//   6. reconcileTaskExceptions → taskException{break_glass:true, severity:"high"}
//      (BREAK_GLASS_ON_FAIL_CHECK_KEYS forces this regardless of dollar impact)
// ---------------------------------------------------------------------------
test("unregistered A2P: reconcileTaskExceptions produces break-glass exception", async () => {
  // Find the comms.deliverability registry task — skip cleanly if not yet seeded
  const [delivTask] = await adminDb
    .select({ id: taskRegistry.id, defaultMode: taskRegistry.defaultMode })
    .from(taskRegistry)
    .where(eq(taskRegistry.checkKey, "comms.deliverability"))
    .limit(1);

  if (!delivTask) {
    test.skip(true, "comms.deliverability task not seeded in task_registry — run db:seed first");
    return;
  }

  const taskId = delivTask.id;
  const stamp = randomUUID().slice(0, 8);
  const tenantId = randomUUID();

  // Seed an isolated tenant with no Twilio integration_connection (unregistered)
  await adminDb.insert(tenant).values({
    id: tenantId,
    name: `Unreg A2P ${stamp}`,
    publicKey: `ua-${stamp}`,
    clerkOrgId: `org-ua-${stamp}`,
    settings: {},
  });

  // Enable the task in full_auto mode for this tenant so recomputeTaskHealth
  // sets a real status (mode="manual" → gray, which is never an exception).
  await adminDb.insert(tenantTaskConfig).values({
    tenantId,
    taskId,
    mode: "full_auto",
    enabled: true,
    params: {},
  });

  // Seed a failing verification_run (equivalent to what the check returns when
  // getA2pRegistration returns registered:false).
  const [vr] = await adminDb
    .insert(verificationRun)
    .values({
      tenantId,
      taskId,
      checkKey: "comms.deliverability",
      status: "fail",
      details: { message: "A2P 10DLC not registered — SMS may be silently filtered" },
      refs: [],
    })
    .returning({ id: verificationRun.id });

  try {
    // Drive the same DB pipeline that sweepTenantHealth calls after running checks
    await recomputeTaskHealth(tenantId, taskId);
    await reconcileTaskExceptions(tenantId);

    // Assert the persisted exception has break_glass=true and severity="high".
    // BREAK_GLASS_ON_FAIL_CHECK_KEYS includes "comms.deliverability", so
    // reconcileTaskExceptions forces these regardless of dollar impact.
    const [exc] = await adminDb
      .select({
        breakGlass: taskException.breakGlass,
        severity: taskException.severity,
        kind: taskException.kind,
      })
      .from(taskException)
      .where(
        and(
          eq(taskException.tenantId, tenantId),
          eq(taskException.taskId, taskId),
          isNull(taskException.resolvedAt),
        ),
      );

    expect(exc, "task_exception row should exist for the comms.deliverability task").toBeTruthy();
    expect(exc!.breakGlass).toBe(true);
    expect(exc!.severity).toBe("high");
    // The single failing run (not yet 2 consecutive) produces "task_regression"
    expect(exc!.kind).toBe("task_regression");
  } finally {
    // Teardown in FK order: exception/health/run/config → tenant
    await adminDb.delete(taskException).where(eq(taskException.tenantId, tenantId));
    await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
    await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantId));
    await adminDb.delete(tenantTaskConfig).where(eq(tenantTaskConfig.tenantId, tenantId));
    await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  }
});
