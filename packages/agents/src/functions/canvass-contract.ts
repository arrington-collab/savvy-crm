import { withTenant, and, eq, lead, document } from "@savvy/db";
import type { StorageGateway } from "@savvy/integrations";
import { r2Storage } from "@savvy/integrations";
import type { CanvassContract } from "@savvy/core";
import { inngest } from "../client";

/**
 * Stores a signed canvass contract as a tenant document: the full contract
 * (fields, scope items, signature data-URL, consent, hash) as a JSON blob in
 * R2 plus a `document` row (kind "contract") linked to the lead's customer.
 *
 * Pure helper (injectable storage) so it can be tested with a fake gateway
 * against a real DB. Idempotent: the r2Key is derived from the signing
 * integrity hash, and an existing document row with that key stores nothing.
 */
export async function storeCanvassContract(
  input: { tenantId: string; leadId: string; contract: CanvassContract },
  deps: { storage: StorageGateway },
): Promise<{ stored: boolean; reason?: string }> {
  const { tenantId, leadId, contract } = input;
  const dedupe = contract.integrityHash ?? `${leadId}-${Date.parse(contract.signedAt)}`;
  const r2Key = `${tenantId}/canvass/contract-${dedupe.toLowerCase()}.json`;

  const [l] = await withTenant(tenantId, (tx) =>
    tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, leadId)),
  );
  if (!l) return { stored: false, reason: "lead_not_found" };

  const dup = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: document.id })
      .from(document)
      .where(and(eq(document.tenantId, tenantId), eq(document.r2Key, r2Key))),
  );
  if (dup.length) return { stored: false, reason: "already_stored" };

  const bytes = new TextEncoder().encode(JSON.stringify(contract));
  await deps.storage.putObject({ key: r2Key, bytes, contentType: "application/json" });

  await withTenant(tenantId, (tx) =>
    tx.insert(document).values({
      tenantId,
      customerId: l.customerId,
      kind: "contract",
      label: contract.document,
      r2Key,
      filename: `${contract.kind}-contract-${contract.signedAt.slice(0, 10)}.json`,
      mime: "application/json",
      sizeBytes: bytes.byteLength,
      source: "savvy",
    }),
  );
  return { stored: true };
}

export const canvassContractSigned = inngest.createFunction(
  { id: "canvass-contract-signed" },
  { event: "canvass/contract.signed" },
  async ({ event, step }) =>
    step.run("store-document", () => storeCanvassContract(event.data, { storage: r2Storage })),
);
