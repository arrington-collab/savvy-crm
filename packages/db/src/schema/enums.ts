import { pgEnum } from "drizzle-orm/pg-core";
import {
  JOB_TYPE, JOB_STAGE, TASK_STATUS, AUTOMATION_LEVEL, AGENT,
  COMM_CHANNEL, COMM_DIRECTION, LEAD_STATUS, USER_ROLE,
  MESSAGE_CHANNEL, DRIP_STATUS, DRIP_STOP_REASON,
  APPOINTMENT_TYPE, APPOINTMENT_STATUS,
  INVOICE_STATUS, PAYMENT_METHOD,
  COMMISSION_MODEL, COMMISSION_STATUS,
  PRICE_BOOK_CATEGORY, PRICE_BOOK_UNIT,
  STORM_CERT_STATUS,
  MATERIAL_ORDER_STATUS,
  CLAIM_STATUS,
  TELEPHONY_PROVIDER, INTEGRATION_STATUS, TELEPHONY_MODE,
  TASK_OWNER, TASK_MODE, TASK_SCOPE, VERIFICATION_TIER,
  JOB_TASK_STATUS, EVIDENCE_STATUS, TASK_HEALTH_STATUS,
  SUPPLIER_INVOICE_STATUS,
} from "@savvy/core";

export const supplierInvoiceStatusEnum = pgEnum("supplier_invoice_status", SUPPLIER_INVOICE_STATUS);
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
export const commissionModelEnum = pgEnum("commission_model", COMMISSION_MODEL);
export const commissionStatusEnum = pgEnum("commission_status", COMMISSION_STATUS);
export const priceBookCategoryEnum = pgEnum("price_book_category", PRICE_BOOK_CATEGORY);
export const priceBookUnitEnum = pgEnum("price_book_unit", PRICE_BOOK_UNIT);
export const stormCertStatusEnum = pgEnum("storm_cert_status", STORM_CERT_STATUS);
export const materialOrderStatusEnum = pgEnum("material_order_status", MATERIAL_ORDER_STATUS);
export const claimStatusEnum = pgEnum("claim_status", CLAIM_STATUS);
export const telephonyProviderEnum = pgEnum("telephony_provider", TELEPHONY_PROVIDER);
export const integrationStatusEnum = pgEnum("integration_status", INTEGRATION_STATUS);
export const telephonyModeEnum = pgEnum("telephony_mode", TELEPHONY_MODE);
export const taskOwnerEnum = pgEnum("task_owner", TASK_OWNER);
export const taskModeEnum = pgEnum("task_mode", TASK_MODE);
export const taskScopeEnum = pgEnum("task_scope", TASK_SCOPE);
export const verificationTierEnum = pgEnum("verification_tier", VERIFICATION_TIER);
export const jobTaskStatusEnum = pgEnum("job_task_status", JOB_TASK_STATUS);
export const evidenceStatusEnum = pgEnum("evidence_status", EVIDENCE_STATUS);
export const taskHealthStatusEnum = pgEnum("task_health_status", TASK_HEALTH_STATUS);
