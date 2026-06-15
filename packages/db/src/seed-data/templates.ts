import type { JobType, JobStage, Agent } from "@savvy/core";
import data from "./task-lifecycle.json";

export type TaskTemplate = {
  key: string;
  num: number;
  title: string;
  phase: string;
  stage: JobStage | null; // null => org-level, not seeded per job
  orgLevel: boolean;
  jobTypes: JobType[];
  automationLevel: "full" | "partial" | "manual";
  ownerAgent: Agent | null;
  ownerRole: string;
  trigger: string;
  difficulty: number;
  whatGetsAutomated: string;
};

export const PHASE_TO_STAGE: Record<string, JobStage | "ORG"> = {
  "Lead Generation": "lead",
  "Lead Management": "lead",
  "Inspection": "inspected",
  "Estimating": "estimate",
  "Insurance Claim Management": "approved",
  "Pre-Production": "approved",
  "Production": "production",
  "Scheduling & Crew Management": "production",
  "Close-Out": "closeout",
  "Billing & Collections": "billing",
  "Reviews & Reputation": "complete",
  "Referrals & Retention": "complete",
  "Warranty Management": "complete",
  "Operations & Compliance": "ORG",
  "Reporting & Analytics": "ORG",
};

export const TASK_TEMPLATES = data as TaskTemplate[];
