export const JOB_TYPE = ["retail", "insurance", "repair", "commercial"] as const;
export const JOB_STAGE = ["lead","inspected","estimate","approved","production","closeout","billing","complete","lost"] as const;
export const TASK_STATUS = ["pending","in_progress","blocked","done","skipped"] as const;
export const AUTOMATION_LEVEL = ["full","partial","manual"] as const;
export const AGENT = ["orchestrator","comms","scheduling","finance","claims"] as const;
export const COMM_CHANNEL = ["call","sms","email"] as const;
export const COMM_DIRECTION = ["inbound","outbound"] as const;
export const LEAD_STATUS = ["new","contacted","qualified","booked","won","lost"] as const;
export const USER_ROLE = ["owner","admin","rep","crew","office"] as const;

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
export const AI_DRAFT_CAPABILITY = ["reason", "summarize"] as const;

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
export const APPOINTMENT_TYPE = ["inspection", "cm", "crew"] as const;
export const APPOINTMENT_STATUS = ["scheduled", "done", "canceled", "no_show"] as const;
export type AppointmentType = (typeof APPOINTMENT_TYPE)[number];
export type AppointmentStatus = (typeof APPOINTMENT_STATUS)[number];
