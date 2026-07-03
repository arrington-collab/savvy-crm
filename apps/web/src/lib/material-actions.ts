"use server";
import { revalidatePath } from "next/cache";
import { withTenant, estimate, and, eq, desc, createMaterialOrderFromEstimate, setMaterialOrderStatus } from "@savvy/db";
import { inngest } from "@savvy/agents";
import type { MaterialOrderStatus } from "@savvy/core";
import { getTenantId } from "./tenant";
import { log } from "./log";

/** Generate a material order from the job's latest accepted estimate. */
export async function generateMaterialOrderAction(input: { jobId: string }) {
  const tenantId = await getTenantId();
  const est = await withTenant(tenantId, async (tx) => {
    const [e] = await tx.select({ id: estimate.id })
      .from(estimate)
      .where(and(eq(estimate.jobId, input.jobId), eq(estimate.status, "accepted")))
      .orderBy(desc(estimate.acceptedAt))
      .limit(1);
    return e ?? null;
  });
  if (!est) return { error: "no_accepted_estimate" as const };
  const order = await createMaterialOrderFromEstimate({ tenantId, estimateId: est.id });
  if (!order) return { error: "no_accepted_estimate" as const };
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true as const, id: order.id };
}

export async function advanceMaterialOrderStatusAction(input: {
  materialOrderId: string; jobId: string; status: MaterialOrderStatus;
}) {
  const tenantId = await getTenantId();
  await setMaterialOrderStatus({ tenantId, materialOrderId: input.materialOrderId, status: input.status });
  // Derived status (§B): confirmed delivery (with a crew assigned) advances the job to production. Fail-soft.
  if (input.status === "delivered") {
    try { await inngest.send({ name: "material/delivered", data: { tenantId, jobId: input.jobId, materialOrderId: input.materialOrderId } }); }
    catch (e) { log.error("material/delivered emit failed", { jobId: input.jobId, msg: String(e) }); }
  }
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true as const };
}
