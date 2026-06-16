import { nangoProxy } from "./nango";

export interface RoofrReport {
  ready: boolean;
  areas: {
    squares: number;
    predominantPitch: string;
    ridgeLf: number;
    hipLf: number;
    valleyLf: number;
    eaveLf: number;
    rakeLf: number;
    stepFlashingLf: number;
    penetrationCount: number;
    facetCount: number;
  };
  reportUrl: string;
  costCents: number; // Roofr cost + $3 markup
}

export interface RoofrGateway {
  orderMeasurement(o: { address: string }): Promise<{ orderId: string }>;
  getReport(orderId: string): Promise<RoofrReport>;
}

const ROOFR_INTEGRATION = () => process.env.NANGO_ROOFR_INTEGRATION_ID ?? "roofr";
const MARKUP_CENTS = 300;

export const nangoRoofr: RoofrGateway = {
  async orderMeasurement({ address }) {
    const res = await nangoProxy({
      connectionId: "roofr",
      integrationId: ROOFR_INTEGRATION(),
      method: "POST",
      endpoint: "/orders",
      body: { address },
    });
    return { orderId: String((res as { id?: string }).id ?? "") };
  },
  async getReport(orderId) {
    const res = (await nangoProxy({
      connectionId: "roofr",
      integrationId: ROOFR_INTEGRATION(),
      method: "GET",
      endpoint: `/orders/${orderId}`,
    })) as Record<string, unknown>;
    const a = (res.measurements ?? {}) as Record<string, number>;
    return {
      ready: res.status === "complete",
      areas: {
        squares: a.squares ?? 0,
        predominantPitch: String(res.pitch ?? "0/12"),
        ridgeLf: a.ridge ?? 0,
        hipLf: a.hip ?? 0,
        valleyLf: a.valley ?? 0,
        eaveLf: a.eave ?? 0,
        rakeLf: a.rake ?? 0,
        stepFlashingLf: a.stepFlashing ?? 0,
        penetrationCount: a.penetrations ?? 0,
        facetCount: a.facets ?? 0,
      },
      reportUrl: String(res.reportUrl ?? ""),
      costCents: Math.round(Number(res.priceCents ?? 0)) + MARKUP_CENTS,
    };
  },
};

export function makeFakeRoofr(): RoofrGateway & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    async orderMeasurement() {
      const orderId = `roofr_ord_${++n}`;
      calls.push(`order:${orderId}`);
      return { orderId };
    },
    async getReport(orderId) {
      calls.push(`report:${orderId}`);
      return {
        ready: true,
        areas: {
          squares: 24.5,
          predominantPitch: "7/12",
          ridgeLf: 40,
          hipLf: 20,
          valleyLf: 15,
          eaveLf: 120,
          rakeLf: 60,
          stepFlashingLf: 10,
          penetrationCount: 4,
          facetCount: 8,
        },
        reportUrl: `https://roofr.test/reports/${orderId}`,
        costCents: 2500 + 300,
      };
    },
  };
}
