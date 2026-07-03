import { EventSchemas, Inngest } from "inngest";

// Event types the app emits. Add new events here as workflows grow.
type Events = {
  "lead/created": { data: { leadId: string; tenantId: string } };
  "demo/ping": { data: { msg: string } };
  "job/stage-changed": { data: { jobId: string; tenantId: string; toStage: string; byAgent?: string } };
  "drip/enroll": { data: { tenantId: string; dripKey: string; customerId: string; jobId?: string; leadId?: string } };
  "drip/stop": { data: { tenantId: string; customerId: string; reason: "reply" | "converted" | "opted_out" | "manual" } };
  "appointment/booked": { data: { appointmentId: string; tenantId: string } };
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
  "roofr/order.requested": { data: { tenantId: string; jobId: string; propertyId: string } };
  "measurement/ready": { data: { tenantId: string; jobId: string; measurementId: string } };
  "estimate/send.requested": { data: { tenantId: string; estimateId: string } };
  "estimate/accepted": { data: { tenantId: string; estimateId: string } };
  "change_order/accepted": { data: { changeOrderId: string; tenantId: string } };
  "lead/contacted": { data: { leadId: string; tenantId: string } };
  "lead/contact-overdue": { data: { leadId: string; tenantId: string } };
  "lead/disqualified": { data: { leadId: string; tenantId: string } };
};

export const inngest = new Inngest({
  id: "savvy",
  schemas: new EventSchemas().fromRecord<Events>(),
});
export type SavvyEvents = Events;
