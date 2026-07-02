/**
 * Named master-task ids for the execution points that write ledger evidence
 * (job_task / lead_task). Binds code to the registry BY ID (the mechanical seed
 * slugs differ from these semantic names — see the Scoreboard spec). One place
 * to see every "this code path proves this task ran".
 */
export const REGISTRY_TASK = {
  FOLLOW_UP_SEQUENCE: 24, // ph2, per_lead — drip send
  APPOINTMENT_SCHEDULING: 25, // ph2, per_lead — inspection booked
  ESTIMATE_DELIVERY: 56, // ph4, per_job — estimate sent
  INVOICE_GENERATION: 139, // ph9, per_job — invoice created
  INVOICE_DELIVERY: 140, // ph9, per_job — invoice sent
} as const;

export type RegistryTaskId = (typeof REGISTRY_TASK)[keyof typeof REGISTRY_TASK];
