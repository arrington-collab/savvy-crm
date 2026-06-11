import { pgEnum } from "drizzle-orm/pg-core";
import {
  JOB_TYPE, JOB_STAGE, TASK_STATUS, AUTOMATION_LEVEL, AGENT,
  COMM_CHANNEL, COMM_DIRECTION, LEAD_STATUS, USER_ROLE,
  MESSAGE_CHANNEL, DRIP_STATUS, DRIP_STOP_REASON,
  APPOINTMENT_TYPE, APPOINTMENT_STATUS,
  INVOICE_STATUS, PAYMENT_METHOD,
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
export const messageChannelEnum = pgEnum("message_channel", MESSAGE_CHANNEL);
export const dripStatusEnum = pgEnum("drip_status", DRIP_STATUS);
export const dripStopReasonEnum = pgEnum("drip_stop_reason", DRIP_STOP_REASON);
export const appointmentTypeEnum = pgEnum("appointment_type", APPOINTMENT_TYPE);
export const appointmentStatusEnum = pgEnum("appointment_status", APPOINTMENT_STATUS);
export const invoiceStatusEnum = pgEnum("invoice_status", INVOICE_STATUS);
export const paymentMethodEnum = pgEnum("payment_method", PAYMENT_METHOD);
