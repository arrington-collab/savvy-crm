import { describe, it, expect } from "vitest";
import { makeFakeStormProof, makeFakeStorage } from "@savvy/integrations";
import { runStormCert } from "./storm-cert";

// Minimal fake "ctx loader" + recorder so the core logic is testable without a DB.
function fakeDeps(over: Partial<Parameters<typeof runStormCert>[0]> = {}) {
  const updates: any[] = [];
  const docs: any[] = [];
  return {
    leadId: "lead1",
    tenantId: "t1",
    loadLead: async () => ({ customerId: "cust1", address: "1 Main St", lat: 39.3, lng: -104.2, existingDocId: null as string | null }),
    gateway: makeFakeStormProof(),
    storage: makeFakeStorage(),
    createCertDocument: async (d: any) => { docs.push(d); return "doc1"; },
    updateLead: async (u: any) => { updates.push(u); },
    _updates: updates, _docs: docs,
    ...over,
  };
}

describe("runStormCert", () => {
  it("verified: stores PDF + creates cert doc + marks lead verified", async () => {
    const d = fakeDeps();
    const out = await runStormCert(d as any);
    expect(out.status).toBe("verified");
    expect(d._docs[0]).toMatchObject({ kind: "cert", customerId: "cust1" });
    expect((d.storage as any).calls.some((c: any) => c.op === "put" || c.op === "upload")).toBe(true);
    expect(d._updates.at(-1)).toMatchObject({ stormCertStatus: "verified" });
  });

  it("none: no address and no coords → marks none, never calls gateway", async () => {
    const fake = makeFakeStormProof();
    const d = fakeDeps({ loadLead: async () => ({ customerId: "c", address: null, lat: null, lng: null, existingDocId: null }), gateway: fake });
    const out = await runStormCert(d as any);
    expect(out.status).toBe("none");
    expect(fake.calls.length).toBe(0);
    expect(d._updates.at(-1)).toMatchObject({ stormCertStatus: "none" });
  });

  it("none: gateway says not verified → marks none", async () => {
    const d = fakeDeps({ gateway: { generateCertificate: async () => ({ verified: false, checkedMonths: 24 }) } as any });
    const out = await runStormCert(d as any);
    expect(out.status).toBe("none");
    expect(d._updates.at(-1)).toMatchObject({ stormCertStatus: "none" });
  });

  it("idempotent: existing cert doc id → does not create a second doc", async () => {
    const d = fakeDeps({ loadLead: async () => ({ customerId: "c", address: "x", lat: 1, lng: 2, existingDocId: "docPrev" }) });
    const out = await runStormCert(d as any);
    expect(out.status).toBe("verified");
    expect(d._docs.length).toBe(0);
    expect(d._updates.at(-1)).toMatchObject({ stormCertStatus: "verified", stormCertDocumentId: "docPrev" });
  });
});
