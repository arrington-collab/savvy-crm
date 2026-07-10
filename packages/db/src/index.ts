export { db, pool, schema } from "./client";
export { adminDb, adminPool } from "./admin-client";
export { withTenant, type Tx } from "./tenant";
export { seedJobTasks } from "./lifecycle/seed-job-tasks";
export { instantiateJobTasks, markJobTaskDone, markJobTaskDoneTx, backfillJobTasks, setJobTaskAutomationLevel, completeJobTaskManually } from "./lifecycle/job-tasks";
export { instantiateLeadTasks, markLeadTaskDone, markLeadTaskDoneTx, backfillLeadTasks, resolveOpenLeadTasks, ConversionBlockedError } from "./lifecycle/lead-tasks";
export { addLeadNote, getLeadNotes } from "./lifecycle/lead-note";
export { recomputeTaskHealth, spotVerifyDoneTasks, computeTaskExceptions, computeTenantRollup, reconcileTaskExceptions, getTenantRollup, getJobLedger, type JobLedgerRow, listOpenTaskExceptions, type OpenTaskException, markTaskExceptionViewed, getTaskDetail, type TaskDetail, recomputeFounderMinutes, listAutomationRoadmap, type RoadmapTask } from "./lifecycle/task-health";
export { recordStageChange, IncompletePhotosError, IncompleteDocumentsError, StageEvidenceError, BackwardNeedsReasonError } from "./lifecycle/record-stage-change";
export { advanceJobStageForward } from "./lifecycle/advance-stage";
export { missingProductionPhotos, hasScheduledCrewInstall } from "./lifecycle/production-signals";
export { gatherStageEvidence } from "./lifecycle/stage-evidence-db";
export { detectDepreciationRecovery, draftDepreciationInvoice, sendDepreciationInvoice, DEPRECIATION_TASK_KEY, DEPRECIATION_APPROVAL_TASK_KEY } from "./lifecycle/depreciation-recovery";
export { stopDripEnrollments } from "./lifecycle/stop-drip";
export { setLeadOwner, setLeadLost } from "./lifecycle/leads";
export { markLeadContacted, markCustomerLeadsContacted } from "./lifecycle/contact";
export { setCustomerEmail, findCustomersNeedingEmail, type EmailSource, type CustomerEmailDue } from "./lifecycle/customer";
export {
  bookAppointment, rescheduleAppointment, reassignAppointment, cancelAppointment, setAppointmentStatus,
  getBusyIntervals, getCrewBusyStarts, convertLeadToJob, setAppointmentWeatherFlag, SlotTakenError, NoAssigneeError,
  RescissionHoldError, ManualJobEvidenceError,
} from "./lifecycle/appointments";
export {
  createInvoice, createInvoiceFromEstimate, sendInvoice, voidInvoice,
  recordStripePayment, StripeNotConnectedError,
} from "./lifecycle/invoices";
export { recordCommission } from "./lifecycle/commission";
export { chargebackCommissionsForJob } from "./lifecycle/commission-chargeback";
export { recomputeJobActualCost, saveParsedSupplierInvoice, getDocumentR2Key, matchSupplierInvoiceJob, markSupplierInvoiceParseFailed, getMaterialOrderSnapshot, saveGuardedSupplierInvoice, listUnmatchedSupplierInvoices, listSupplierInvoicesForJob } from "./lifecycle/supplier-invoice";
export { createCreditRequest, setCreditRequestSent, listOpenSentCreditRequests, markCreditRequestCredited, getCreditRecoverySummary, listDraftedCreditRequests } from "./lifecycle/credit-request";
export { markEsignBySubmission } from "./lifecycle/esign";
export { createChangeOrder, sendChangeOrder, markChangeOrderBySubmission, approveChangeOrder } from "./lifecycle/change-order";
export * as tables from "./schema/index";
// Named table/enum exports on the package root so cross-package consumers
// (the Next.js app, agents) import `{ tenant, job }` from "@savvy/db" instead
// of deep `/src/schema/...js` paths that webpack can't resolve to .ts files.
export * from "./schema/index";
// Re-export the query operators consumers need, so app code uses THIS package's
// single drizzle-orm instance (avoids duplicate-instance type mismatches where
// the app's own `eq` doesn't match @savvy/db's columns).
export { eq, and, or, not, sql, count, desc, asc, inArray, isNull, isNotNull, lt, gte, lte, gt, ilike } from "drizzle-orm";
export { ensurePriceBook } from "./lifecycle/price-book";
export { createEstimateFromMeasurement, draftLeadEstimateIfReady, resolveEstimateDelivery, setEstimateStatus } from "./lifecycle/estimate";
export { getLeadArtifacts, type LeadArtifacts } from "./lifecycle/lead-artifacts";
export { recordLeadDocument, listLeadDocuments, type LeadDocumentRow } from "./lifecycle/lead-documents";
export { getLeadDocumentForParse, upsertUploadedMeasurement, setDocumentParseStatus, getDocumentParseSummaries, getDocumentForView } from "./lifecycle/lead-documents";
export { saveSketchMeasurement, type SketchScope, type SaveSketchMeasurementResult } from "./lifecycle/measurement";
export { computeTenantUsage, recordUsageSnapshot } from "./lifecycle/usage";
export { setCallDuration, recordVoiceCallReport, setLeadVoiceCallId, getLeadByVoiceCallId } from "./lifecycle/voice";
export { recordAgentRun, listAgentActivity, type AgentRunStatus, type AgentActivityRow } from "./lifecycle/agent-run";
export {
  recordEnrichmentAttempt,
  findPropertiesNeedingGeocode,
  findPropertiesNeedingStormproof,
  findLeadIdForProperty,
  MAX_ENRICH_ATTEMPTS,
  ENRICH_BACKOFF_MS,
  type EnrichmentStatus,
  type PropertyDue,
} from "./lifecycle/enrichment";
export { openCheckIn, closeCheckIn } from "./lifecycle/crew-checkin";
export { recordCompanyCamPhoto } from "./lifecycle/companycam";
export { resolvePhotoJob, resolveTenantByIngestKey, recordSiteSnapPhoto, listUnmatchedPhotos, matchPhotoToJob, getPhotoForQc, getJobPhotoHashes, setPhotoQc, listFlaggedPhotos, listFlaggedPhotosForJob, keepFlaggedPhoto } from "./lifecycle/photos";
export { ensureTenantForOrg, ensureUser, deactivateUserByClerkId } from "./lifecycle/provisioning";
// NOTE: provision-runbook is intentionally NOT re-exported from this barrel. It
// imports the registry SEED (master-task-list.ts, which uses `.js`-extension
// imports that Turbopack can't resolve), and this index is transitively pulled
// into the Next app graph via @savvy/agents. The runbook is an ops utility — the
// CLI (src/scripts/provision-tenant.ts) and its test import it directly.
export { setOnboardingRequiredComplete, setOnboardingProfile, dismissOnboarding } from "./lifecycle/onboarding";
export { addLeadSource, getCustomLeadSources } from "./lifecycle/lead-sources";
export { getAssignmentCandidates, getAssignmentSettings, saveAssignmentConfig, getRepSameDayAppts, getSchedulingOffice, getScoringSettings, recommendAssignee, type DbAssignmentCandidate } from "./lifecycle/assignment";
export { bookLeadSlot } from "./lifecycle/booking";
export { getRepBlocks, repsAvailableAt, createRepBlock, listRepBlocks, deleteRepBlock } from "./lifecycle/availability";
export { createBookingLink, createStatusLink, resolveBookingLink } from "./lifecycle/booking-link";
export { claimCommunication } from "./lifecycle/claim-communication";
export { listAssignableReps } from "./lifecycle/team";
export { createMaterialOrderFromEstimate, setMaterialOrderStatus, getJobInstallDate, type MaterialOrderRow } from "./lifecycle/material-order";
export { resolveTaskAutomation, gateAgentAutomation } from "./lifecycle/task-automation";
export { getHomeownerStatus, listStageEventsToNotify, markStageEventNotified, type HomeownerStatus, type NotifiableEvent } from "./lifecycle/homeowner";
export { upsertClaim, getClaimForJob, getAdjusterAppointmentForJob, bookAdjusterMeeting, attachOrCreateLeadClaim, type ClaimRow, type AdjusterAppointment, type BookAdjusterMeetingInput } from "./lifecycle/claim";
export { createCrew, listCrews, renameCrew, setCrewActive, setCrewLocation, setCrewPinHash, getCrewLoginCandidates, addCrewMember, removeCrewMember, listCrewIdsForUser, getCrewContacts, type CrewRow } from "./lifecycle/crew";
export {
  getTelephonyMode, setTelephonyMode, upsertTwilioConnection, getTelephonyConnection,
  getTwilioSecret, setTelephonyConnectionStatus, requestManagedTelephonySetup,
  disconnectTelephony, listManagedSetupRequests, resolveTelephonyCreds,
  type TwilioSecret, type TelephonyConnectionView, type ManagedSetupRequest,
  type ResolvedTwilioCreds, type TelephonyResolution,
  upsertVapiConnection, getVapiConnection, getVapiSecret, resolveVoiceCreds, tenantByVapiAssistant,
  type VapiSecret, type VapiConnectionView, type VoiceResolution,
} from "./lifecycle/telephony";
export { listSupplierAllowlist, listAllowedDomains, addSupplierAllowlistDomain, removeSupplierAllowlistDomain } from "./lifecycle/supplier-allowlist";
export { applyDeliveryReceipt } from "./lifecycle/delivery-status";
export { getA2pRegistration, setA2pRegistration } from "./lifecycle/a2p";
export { setJobFinancingStatus } from "./lifecycle/financing";
export { setClaimEndorsement } from "./lifecycle/endorsement";

export { convertCanvassContractToJob } from "./lifecycle/canvass-conversion";
