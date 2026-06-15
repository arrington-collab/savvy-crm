import { nangoProxy } from "./nango";

export interface QboGateway {
  upsertCustomer(o: { connectionId: string; customer: { id: string; name: string; email?: string } }): Promise<{ qboId: string }>;
  upsertInvoice(o: { connectionId: string; qboCustomerId: string; invoice: { number: string; lineItems: unknown[]; amountCents: number; dueAt: string | null } }): Promise<{ qboId: string }>;
  recordPayment(o: { connectionId: string; qboInvoiceId: string; amountCents: number; receivedAt: string }): Promise<{ qboId: string }>;
}

const QBO_INTEGRATION = () => process.env.NANGO_QBO_INTEGRATION_ID ?? "quickbooks";

export const nangoQbo: QboGateway = {
  async upsertCustomer({ connectionId, customer }) {
    // NOTE: QBO create-customer is NOT idempotent at the API level (no match-by-name). True
    // idempotency needs query-then-create or a sparse update. The DB-level customer.qboId guard
    // covers clean retries; harden here during QBO sandbox validation (follow-up).
    const res = await nangoProxy({
      connectionId,
      integrationId: QBO_INTEGRATION(),
      method: "POST",
      endpoint: "/v3/company/customer",
      body: {
        DisplayName: customer.name,
        PrimaryEmailAddr: customer.email ? { Address: customer.email } : undefined,
      },
    });
    return { qboId: String((res as { Customer?: { Id: string } }).Customer?.Id ?? "") };
  },

  async upsertInvoice({ connectionId, qboCustomerId, invoice }) {
    const res = await nangoProxy({
      connectionId,
      integrationId: QBO_INTEGRATION(),
      method: "POST",
      endpoint: "/v3/company/invoice",
      body: {
        CustomerRef: { value: qboCustomerId },
        DocNumber: invoice.number,
        Line: [
          {
            Amount: invoice.amountCents / 100,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: {},
          },
        ],
      },
    });
    return { qboId: String((res as { Invoice?: { Id: string } }).Invoice?.Id ?? "") };
  },

  async recordPayment({ connectionId, qboInvoiceId, amountCents, receivedAt }) {
    const res = await nangoProxy({
      connectionId,
      integrationId: QBO_INTEGRATION(),
      method: "POST",
      endpoint: "/v3/company/payment",
      body: {
        TotalAmt: amountCents / 100,
        TxnDate: receivedAt.substring(0, 10),
        Line: [
          {
            Amount: amountCents / 100,
            LinkedTxn: [{ TxnId: qboInvoiceId, TxnType: "Invoice" }],
          },
        ],
      },
    });
    return { qboId: String((res as { Payment?: { Id: string } }).Payment?.Id ?? "") };
  },
};

export function makeFakeQbo(): QboGateway & { calls: { op: string; id: string }[] } {
  const calls: { op: string; id: string }[] = [];
  let n = 0;
  return {
    calls,
    async upsertCustomer() {
      const qboId = `qbo_cust_${++n}`;
      calls.push({ op: "customer", id: qboId });
      return { qboId };
    },
    async upsertInvoice() {
      const qboId = `qbo_inv_${++n}`;
      calls.push({ op: "invoice", id: qboId });
      return { qboId };
    },
    async recordPayment() {
      const qboId = `qbo_pmt_${++n}`;
      calls.push({ op: "payment", id: qboId });
      return { qboId };
    },
  };
}
