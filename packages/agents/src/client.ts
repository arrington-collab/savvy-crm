import { EventSchemas, Inngest } from "inngest";
import type { CanvassContract } from "@savvy/core";

// Event types the app emits. Add new events here as workflows grow.
type Events = {
  "lead/created": { data: { leadId: string; tenantId: string } };
  "demo/ping": { data: { msg: string } };
  "job/stage-changed": { data: { jobId: string; tenantId: string; toStage: string; byAgent?: string } };
  "drip/enroll": { data: { tenantId: string; dripKey: string; customerId: string; jobId?: string; leadId?: string } };
  "drip/stop": { data: { tenantId: string; customerId: string; reason: "reply" | "converted" | "opted_out" | "manual" } };
  "appointment/booked": { data: { appointmentId: string; tenantId: string } };
  // Fired when an appointment is marked done. For a completed lead-stage inspection
  // this (with a landed measurement) triggers the lead's draft estimate.
  "appointment/completed": { data: { appointmentId: string; tenantId: string } };
  "appointment/changed": {
    data: {
      appointmentId: string; tenantId: string;
      reason: "rescheduled" | "reassigned" | "canceled" | "done" | "no_show" | "weather_rescheduled";
      prevAssigneeUserId?: string;
    };
  };
  "crew/checked-in": { data: { tenantId: string; jobId: string } };
  "material/ordered": { data: { tenantId: string; jobId: string; materialOrderId: string } };
  "material/delivered": { data: { tenantId: string; jobId: string; materialOrderId?: string } };
  "job/production-photos-updated": { data: { tenantId: string; jobId: string } };
  "invoice/sent": { data: { invoiceId: string; tenantId: string } };
  "invoice/paid": { data: { invoiceId: string; tenantId: string } };
  "invoice/void": { data: { invoiceId: string; tenantId: string } };
  "esign/completed": { data: { requestId: string; tenantId: string } };
  // Measurement is a PROPERTY artifact; the inspection/estimate that drive it live
  // at the LEAD stage before a job exists. jobId is optional (legacy/job-stage);
  // leadId + propertyId scope the lead-stage flow.
  "roofr/order.requested": { data: { tenantId: string; propertyId: string; jobId?: string; leadId?: string } };
  "measurement/ready": { data: { tenantId: string; measurementId: string; propertyId?: string; jobId?: string; leadId?: string } };
  "estimate/send.requested": { data: { tenantId: string; estimateId: string } };
  "estimate/accepted": { data: { tenantId: string; estimateId: string } };
  "change_order/accepted": { data: { changeOrderId: string; tenantId: string } };
  "lead/contacted": { data: { leadId: string; tenantId: string } };
  "lead/contact-overdue": { data: { leadId: string; tenantId: string } };
  "lead/disqualified": { data: { leadId: string; tenantId: string } };
  "photo/ingested": { data: { tenantId: string; documentId: string; jobId: string | null } };
  // Roof Record: zone-tagged media landed on an inspection zone (fires once per
  // NEW photo — replays are deduped at the pipe). Drives the live pre-draft
  // refresh + the progressive lead-tile card.
  "inspection/media.ingested": { data: { tenantId: string; inspectionId: string; leadId: string | null; zoneKey: string; documentId: string } };
  // The inspector climbed down: capture done, Record + estimate finalize.
  "inspection/completed": { data: { tenantId: string; inspectionId: string; leadId: string | null } };
  "supplier-invoice/received": { data: { tenantId: string; supplierInvoiceId: string; documentId: string } };
  "supplier-invoice/parsed": { data: { tenantId: string; supplierInvoiceId: string; jobId: string | null } };
  // A lead-stage document upload that needs parsing (6b measurement_report, 6c insurance_estimate).
  "lead-document/received": { data: { tenantId: string; documentId: string; leadId: string; kind: string } };
  "canvass/contract.signed": { data: { tenantId: string; leadId: string; contract: CanvassContract; customerEmail?: string | null; customerName?: string | null } };
  // A knock is logged as a sale. Idempotency id "sale:" + knockId ensures one event per knock.
  "canvass/sale.logged": { data: { tenantId: string; knockId: string; repId: string } };
};

export const inngest = new Inngest({
  id: "savvy",
  schemas: new EventSchemas().fromRecord<Events>(),
});
export type SavvyEvents = Events;
