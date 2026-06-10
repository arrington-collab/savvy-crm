import { EventSchemas, Inngest } from "inngest";

// Event types the app emits. Add new events here as workflows grow.
type Events = {
  "lead/created": { data: { leadId: string; tenantId: string } };
  "lead/booked": { data: { leadId: string; tenantId: string; startsAt: string } };
  "demo/ping": { data: { msg: string } };
  "job/stage-changed": { data: { jobId: string; tenantId: string; toStage: string; byAgent?: string } };
  "drip/enroll": { data: { tenantId: string; dripKey: string; customerId: string; jobId?: string; leadId?: string } };
  "drip/stop": { data: { tenantId: string; customerId: string; reason: "reply" | "converted" | "opted_out" | "manual" } };
  "appointment/booked": { data: { appointmentId: string; tenantId: string } };
  "appointment/changed": {
    data: {
      appointmentId: string; tenantId: string;
      reason: "rescheduled" | "reassigned" | "canceled" | "done" | "no_show";
      prevAssigneeUserId?: string;
    };
  };
};

export const inngest = new Inngest({
  id: "savvy",
  schemas: new EventSchemas().fromRecord<Events>(),
});
export type SavvyEvents = Events;
