import { and, eq } from "drizzle-orm";
import { withTenant } from "../tenant";
import { integrationConnection } from "../schema/integrations";
import type { A2pState } from "@savvy/core";
import { isA2pRegistered } from "@savvy/core";

const emptyState = (): A2pState => ({ brandStatus: null, campaignStatus: null, messagingServiceSid: null });

export async function getA2pRegistration(
  tenantId: string,
): Promise<{ registered: boolean; state: A2pState; connectionActive: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ status: integrationConnection.status, metadata: integrationConnection.metadata })
      .from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "twilio")));
    if (!row) return { registered: false, state: emptyState(), connectionActive: false };
    const a2p = ((row.metadata ?? {}) as Record<string, unknown>).a2p as Partial<A2pState> | undefined;
    const state: A2pState = {
      brandStatus: a2p?.brandStatus ?? null,
      campaignStatus: a2p?.campaignStatus ?? null,
      messagingServiceSid: a2p?.messagingServiceSid ?? null,
    };
    const connectionActive = row.status === "active";
    return { registered: isA2pRegistered(state, connectionActive), state, connectionActive };
  });
}

export async function setA2pRegistration(tenantId: string, patch: Partial<A2pState>): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ metadata: integrationConnection.metadata })
      .from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "twilio")));
    const prior = (row?.metadata ?? {}) as Record<string, unknown>;
    const priorA2p = (prior.a2p ?? {}) as Record<string, unknown>;
    await tx
      .update(integrationConnection)
      .set({ metadata: { ...prior, a2p: { ...priorA2p, ...patch } } })
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "twilio")));
  });
}
