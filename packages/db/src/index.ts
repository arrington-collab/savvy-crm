export { db, pool, schema } from "./client";
export { adminDb, adminPool } from "./admin-client";
export { withTenant } from "./tenant";
export { seedJobTasks } from "./lifecycle/seed-job-tasks";
export { recordStageChange, IncompletePhotosError } from "./lifecycle/record-stage-change";
export { stopDripEnrollments } from "./lifecycle/stop-drip";
export {
  bookAppointment, rescheduleAppointment, cancelAppointment, setAppointmentStatus,
  getBusyIntervals, convertLeadToJob, SlotTakenError, NoAssigneeError,
} from "./lifecycle/appointments";
export {
  createInvoice, createInvoiceFromEstimate, sendInvoice, voidInvoice,
  recordStripePayment, StripeNotConnectedError,
} from "./lifecycle/invoices";
export { recordCommission } from "./lifecycle/commission";
export * as tables from "./schema/index";
// Named table/enum exports on the package root so cross-package consumers
// (the Next.js app, agents) import `{ tenant, job }` from "@savvy/db" instead
// of deep `/src/schema/...js` paths that webpack can't resolve to .ts files.
export * from "./schema/index";
// Re-export the query operators consumers need, so app code uses THIS package's
// single drizzle-orm instance (avoids duplicate-instance type mismatches where
// the app's own `eq` doesn't match @savvy/db's columns).
export { eq, and, or, not, sql, count, desc, asc, inArray, isNull, lt, gte, lte, gt } from "drizzle-orm";
export { ensurePriceBook } from "./lifecycle/price-book";
export { createEstimateFromMeasurement, setEstimateStatus } from "./lifecycle/estimate";
export { computeTenantUsage, recordUsageSnapshot } from "./lifecycle/usage";
