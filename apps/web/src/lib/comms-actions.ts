"use server";
import { withTenant, messageTemplate, drip, dripEnrollment, eq, and, stopDripEnrollments } from "@savvy/db";
import { inngest } from "@savvy/agents";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import type { MessageChannel } from "@savvy/core";

export async function saveTemplate(input: {
  id?: string; key: string; name: string; channel: MessageChannel; subject?: string; body: string;
}): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, async (tx) => {
    if (input.id) {
      await tx.update(messageTemplate)
        .set({ name: input.name, channel: input.channel, subject: input.subject ?? null, body: input.body, updatedAt: new Date() })
        .where(eq(messageTemplate.id, input.id));
    } else {
      await tx.insert(messageTemplate).values({
        tenantId, key: input.key, name: input.name, channel: input.channel,
        subject: input.subject ?? null, body: input.body,
      });
    }
  });
  revalidatePath("/comms/templates");
  return { ok: true };
}

export async function toggleDripActive(dripId: string, active: boolean): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, (tx) =>
    tx.update(drip).set({ active }).where(eq(drip.id, dripId)),
  );
  revalidatePath("/comms/drips");
  return { ok: true };
}

export async function enrollDrip(input: {
  dripKey: string; customerId: string; jobId?: string; leadId?: string;
}): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await inngest.send({ name: "drip/enroll", data: { tenantId, ...input } });
  revalidatePath("/comms/enrollments");
  return { ok: true };
}

export async function stopDrip(customerId: string): Promise<{ ok: true }> {
  const tenantId = await getTenantId();
  await withTenant(tenantId, (tx) =>
    stopDripEnrollments(tx, { tenantId, customerId, reason: "manual" }),
  );
  await inngest.send({ name: "drip/stop", data: { tenantId, customerId, reason: "manual" } });
  revalidatePath("/comms/enrollments");
  return { ok: true };
}
