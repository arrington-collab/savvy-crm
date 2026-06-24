import { withTenant, lead, property, document, eq } from "@savvy/db";
import { stormProof as defaultStormProof, r2Storage, type StormProofGateway, type StorageGateway } from "@savvy/integrations";
import { inngest } from "../client";

type LoadResult = { customerId: string | null; address: string | null; lat: number | null; lng: number | null; existingDocId: string | null } | null;

export interface StormCertDeps {
  leadId: string;
  tenantId: string;
  loadLead: () => Promise<LoadResult>;
  gateway: Pick<StormProofGateway, "generateCertificate">;
  storage: Pick<StorageGateway, "putObject">;
  createCertDocument: (d: { tenantId: string; customerId: string | null; r2Key: string; filename: string; externalUrl: string | null; kind: string }) => Promise<string>;
  updateLead: (u: { stormCertStatus: "verified" | "none" | "error"; stormCheckedAt: Date; stormCertDocumentId?: string }) => Promise<void>;
}

// Pure-ish core: no Inngest, no direct DB — all I/O injected. Fully unit-testable.
export async function runStormCert(d: StormCertDeps): Promise<{ status: "verified" | "none"; certId?: string; documentId?: string }> {
  const ctx = await d.loadLead();
  if (!ctx) return { status: "none" };

  if (!ctx.address && (ctx.lat == null || ctx.lng == null)) {
    await d.updateLead({ stormCertStatus: "none", stormCheckedAt: new Date() });
    return { status: "none" };
  }

  const result = await d.gateway.generateCertificate({
    address: ctx.address ?? undefined,
    lat: ctx.lat ?? undefined,
    lng: ctx.lng ?? undefined,
    months: 24,
  });

  if (!result.verified || !result.certId || !result.pdfBase64) {
    await d.updateLead({ stormCertStatus: "none", stormCheckedAt: new Date() });
    return { status: "none" };
  }

  if (ctx.existingDocId) {
    // Idempotent replay: cert doc already exists. Reconcile lead status in case a
    // prior attempt crashed after creating the doc but before updating the lead.
    await d.updateLead({ stormCertStatus: "verified", stormCheckedAt: new Date(), stormCertDocumentId: ctx.existingDocId });
    return { status: "verified", certId: result.certId, documentId: ctx.existingDocId };
  }

  const r2Key = `tenants/${d.tenantId}/certs/${result.certId}.pdf`;
  const bytes = Uint8Array.from(Buffer.from(result.pdfBase64, "base64"));
  await d.storage.putObject({ key: r2Key, bytes, contentType: "application/pdf" });

  const documentId = await d.createCertDocument({
    tenantId: d.tenantId,
    customerId: ctx.customerId,
    kind: "cert",
    r2Key,
    filename: `storm-cert-${result.certId}.pdf`,
    externalUrl: result.verifyUrl ?? null,
  });

  await d.updateLead({ stormCertStatus: "verified", stormCheckedAt: new Date(), stormCertDocumentId: documentId });
  return { status: "verified", certId: result.certId, documentId };
}

export const stormCertOnLead = inngest.createFunction(
  { id: "storm-cert-on-lead", concurrency: { limit: 5 }, idempotency: "event.data.leadId" },
  { event: "lead/created" },
  async ({ event, step }) => {
    const { leadId, tenantId } = event.data;

    const out = await step.run("storm-cert", () =>
      runStormCert({
        leadId,
        tenantId,
        gateway: defaultStormProof,
        storage: r2Storage,
        loadLead: () =>
          withTenant(tenantId, async (tx) => {
            const [l] = await tx.select().from(lead).where(eq(lead.id, leadId));
            if (!l) return null;
            let address: string | null = null;
            let lat: number | null = null;
            let lng: number | null = null;
            if (l.propertyId) {
              const [p] = await tx.select().from(property).where(eq(property.id, l.propertyId));
              if (p) {
                address = p.address;
                lat = p.lat ?? null;
                lng = p.lng ?? null;
              }
            }
            return { customerId: l.customerId, address, lat, lng, existingDocId: l.stormCertDocumentId ?? null };
          }),
        createCertDocument: (dd) =>
          withTenant(tenantId, async (tx) => {
            const [doc] = await tx
              .insert(document)
              .values({
                tenantId: dd.tenantId,
                customerId: dd.customerId,
                kind: dd.kind,
                r2Key: dd.r2Key,
                filename: dd.filename,
                externalUrl: dd.externalUrl,
              })
              .returning();
            return doc!.id;
          }),
        updateLead: (u) =>
          withTenant(tenantId, async (tx) => {
            await tx.update(lead).set(u).where(eq(lead.id, leadId));
          }),
      }),
    );

    return out;
  },
);

// Final-failure handler: after Inngest exhausts retries, mark the lead errored.
export const stormCertOnLeadFailure = inngest.createFunction(
  { id: "storm-cert-on-lead-failure" },
  { event: "inngest/function.failed" },
  async ({ event, step }) => {
    const failed = (event.data as { function_id?: string }).function_id;
    if (failed !== "storm-cert-on-lead") return { ignored: true };
    const orig = (event.data as { event?: { data?: { leadId?: string; tenantId?: string } } }).event?.data;
    if (!orig?.leadId || !orig?.tenantId) return { ignored: true };
    await step.run("mark-error", () =>
      withTenant(orig.tenantId!, async (tx) => {
        await tx
          .update(lead)
          .set({ stormCertStatus: "error", stormCheckedAt: new Date() })
          .where(eq(lead.id, orig.leadId!));
      }),
    );
    return { status: "error" };
  },
);
