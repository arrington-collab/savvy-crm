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
