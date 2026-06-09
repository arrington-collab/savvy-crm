import { pgEnum } from "drizzle-orm/pg-core";
import {
  JOB_TYPE, JOB_STAGE, TASK_STATUS, AUTOMATION_LEVEL, AGENT,
  COMM_CHANNEL, COMM_DIRECTION, LEAD_STATUS, USER_ROLE,
} from "@savvy/core";

export const jobTypeEnum = pgEnum("job_type", JOB_TYPE);
export const jobStageEnum = pgEnum("job_stage", JOB_STAGE);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUS);
export const automationLevelEnum = pgEnum("automation_level", AUTOMATION_LEVEL);
export const agentEnum = pgEnum("agent", AGENT);
export const commChannelEnum = pgEnum("comm_channel", COMM_CHANNEL);
export const commDirectionEnum = pgEnum("comm_direction", COMM_DIRECTION);
export const leadStatusEnum = pgEnum("lead_status", LEAD_STATUS);
export const userRoleEnum = pgEnum("user_role", USER_ROLE);
