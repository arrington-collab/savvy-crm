import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { communication } from "../schema/index";

/**
 * Idempotent "claim then send": inserts a communication row keyed by dedupeKey.
 * Returns the row on success, or null if a row with the same (tenant_id, dedupe_key)
 * already exists (partial unique index). Callers skip the actual send when null.
 */
export async function claimCommunication(input: {
  tenantId: string; jobId: string | null; customerId: string | null;
  channel: "sms" | "email"; direction: "outbound"; to: string; body: string; dedupeKey: string;
}): Promise<{ id: string } | null> {
  try {
    return await withTenant(input.tenantId, async (tx) => {
      const rows = await tx
        .insert(communication)
        .values({
          tenantId: input.tenantId, jobId: input.jobId, customerId: input.customerId,
          channel: input.channel, direction: input.direction, to: input.to, body: input.body,
          dedupeKey: input.dedupeKey, aiHandled: false,
        })
        .returning({ id: communication.id });
      return rows[0] ?? null;
    });
  } catch (err: unknown) {
    // Postgres unique violation (23505) on communication_dedupe_uniq → already sent
    if (err instanceof Error && (err as NodeJS.ErrnoException & { code?: string }).code === "23505") return null;
    throw err;
  }
}
