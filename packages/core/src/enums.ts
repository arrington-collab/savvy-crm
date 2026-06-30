export const JOB_TYPE = ["retail", "insurance", "repair", "commercial"] as const;
export const JOB_STAGE = ["lead","inspected","estimate","approved","production","closeout","billing","complete","lost"] as const;
export const TASK_STATUS = ["pending","in_progress","blocked","done","skipped"] as const;
export const AUTOMATION_LEVEL = ["full","partial","manual"] as const;
export const AGENT = ["orchestrator","comms","scheduling","finance","claims"] as const;
export const COMM_CHANNEL = ["call","sms","email"] as const;
export const COMM_DIRECTION = ["inbound","outbound"] as const;
export const LEAD_STATUS = ["new","contacted","qualified","booked","won","lost"] as const;
export const USER_ROLE = ["owner","admin","rep","crew","office"] as const;
export type UserRole = (typeof USER_ROLE)[number];

export type JobType = (typeof JOB_TYPE)[number];
export type JobStage = (typeof JOB_STAGE)[number];
export type Agent = (typeof AGENT)[number];
export type LeadStatus = (typeof LEAD_STATUS)[number];

// --- Phase 3 (comms) ---
// Channels a drip step can send on. Excludes "call" (from COMM_CHANNEL) —
// drips are async templated/AI messages, not live calls.
export const MESSAGE_CHANNEL = ["sms", "email"] as const;
export const DRIP_STATUS = ["active", "stopped", "completed"] as const;
export const DRIP_STOP_REASON = ["reply", "converted", "opted_out", "manual"] as const;
export const AI_DRAFT_CAPABILITY = ["reasoning", "workhorse", "reflex", "reason", "summarize"] as const;

export type MessageChannel = (typeof MESSAGE_CHANNEL)[number];
export type DripStatus = (typeof DRIP_STATUS)[number];
export type DripStopReason = (typeof DRIP_STOP_REASON)[number];
export type AiDraftCapability = (typeof AI_DRAFT_CAPABILITY)[number];

// One step in a drip sequence. References a template by key OR carries an inline
// AI prompt. delayHours is the wait BEFORE this step sends (relative to prior step).
export type DripStep = {
  stepNum: number;
  delayHours: number;
  channel: MessageChannel;
  templateKey?: string;
  aiPrompt?: string;
  aiCapability?: AiDraftCapability;
};

// --- Phase 4 (scheduling) ---
export const APPOINTMENT_TYPE = ["inspection", "cm", "crew", "adjuster"] as const;
export const APPOINTMENT_STATUS = ["scheduled", "done", "canceled", "no_show"] as const;
export type AppointmentType = (typeof APPOINTMENT_TYPE)[number];
export type AppointmentStatus = (typeof APPOINTMENT_STATUS)[number];

// --- Phase 5 (finance) ---
export const INVOICE_STATUS = ["draft", "sent", "paid", "overdue", "void"] as const;
export const PAYMENT_METHOD = ["card", "ach", "check", "insurance", "mortgage"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

// --- Phase 5B (finance automation) ---
export const COMMISSION_MODEL = ["flat", "profit", "tiered"] as const;
export const COMMISSION_STATUS = ["pending", "approved", "paid"] as const;
export type CommissionModel = (typeof COMMISSION_MODEL)[number];
export type CommissionStatus = (typeof COMMISSION_STATUS)[number];

// --- Storm cert (lead enrichment) ---
export const STORM_CERT_STATUS = ["pending", "verified", "none", "error"] as const;
export type StormCertStatus = (typeof STORM_CERT_STATUS)[number];

// --- Phase 7 (measurement & estimate) ---
export const ESTIMATE_SOURCE = ["roofr", "manual", "carrier"] as const;
export const ESTIMATE_STATUS = ["draft", "sent", "accepted"] as const;
export const PRICE_BOOK_CATEGORY = ["material", "labor", "accessory", "upgrade"] as const;
export const PRICE_BOOK_UNIT = ["square", "lf", "each", "flat"] as const;
export const MEASUREMENT_FIELD = [
  "squares", "ridgeLf", "hipLf", "valleyLf", "eaveLf", "rakeLf", "stepFlashingLf", "penetrationCount",
] as const;
export type EstimateSource = (typeof ESTIMATE_SOURCE)[number];
export type EstimateStatus = (typeof ESTIMATE_STATUS)[number];
export type PriceBookCategory = (typeof PRICE_BOOK_CATEGORY)[number];
export type PriceBookUnit = (typeof PRICE_BOOK_UNIT)[number];
export type MeasurementField = (typeof MEASUREMENT_FIELD)[number];

export const CLAIM_STATUS = ["filed", "adjuster_scheduled", "approved", "partial", "denied", "closed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];

// --- BYO Telephony ---
export const TELEPHONY_PROVIDER = ["twilio", "ringcentral", "vapi"] as const;
export type TelephonyProvider = (typeof TELEPHONY_PROVIDER)[number];

export const INTEGRATION_STATUS = ["pending", "active", "disabled", "setup_requested"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUS)[number];

export const TELEPHONY_MODE = ["platform", "byo"] as const;
export type TelephonyMode = (typeof TELEPHONY_MODE)[number];
