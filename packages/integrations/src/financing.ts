import { mapFinancingStatus, type FinancingStatus } from "@savvy/core";

// Cell 11 financing seam. The provider is DORMANT by default — no vendor is
// wired until the owner picks one (GreenSky-class). The interface carries only a
// neutral application status; approval amounts / APR / any credit data never
// cross it. When a vendor is chosen, implement this interface (httpXxxFinancing)
// and swap it in behind the same seam.
export interface FinancingProvider {
  /** Apply link for a retail estimate, or null when financing is dormant/not offered. */
  applyLink(o: { estimateId: string; amountCents: number; tenantId: string }): Promise<{ url: string } | null>;
  /** Map a vendor webhook payload to a neutral status update, or null if irrelevant. */
  parseWebhook(payload: unknown): { externalRef: string; status: FinancingStatus } | null;
}

/** Default provider: no vendor chosen. Offers nothing, ingests nothing. */
export const dormantFinancing: FinancingProvider = {
  async applyLink() {
    return null;
  },
  parseWebhook() {
    return null;
  },
};

/** In-memory test double behind the seam (dev/e2e). */
export function makeFakeFinancing(): FinancingProvider & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async applyLink(o) {
      calls.push({ op: "apply", ...o });
      return { url: `https://financing.test/apply/${o.estimateId}` };
    },
    parseWebhook(payload) {
      calls.push({ op: "webhook" });
      const p = (payload ?? {}) as { externalRef?: string; status?: string };
      if (!p.externalRef) return null;
      return { externalRef: p.externalRef, status: mapFinancingStatus(p.status) };
    },
  };
}
