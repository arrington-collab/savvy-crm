export { db, pool, schema } from "./client";
export { adminDb, adminPool } from "./admin-client";
export { withTenant, type Tx } from "./tenant";
export { seedJobTasks } from "./lifecycle/seed-job-tasks";
export { instantiateJobTasks, markJobTaskDone, markJobTaskDoneTx, backfillJobTasks, setJobTaskAutomationLevel, completeJobTaskManually } from "./lifecycle/job-tasks";
export { instantiateLeadTasks, markLeadTaskDone, markLeadTaskDoneTx, backfillLeadTasks, resolveOpenLeadTasks, ConversionBlockedError } from "./lifecycle/lead-tasks";
export { addLeadNote, getLeadNotes } from "./lifecycle/lead-note";
export { createLeadForTenant } from "./lifecycle/lead-intake";
export { findOrCreatePartner, findOrCreatePartnerTx, searchPartners, backfillPartnerAttribution, listPartnerMergeCandidates, resolveMergeCandidate } from "./lifecycle/partner";
export { accrueLedgerEntryTx, accrueInspectionStandardCostTx, sweepPartnerLedgerAccruals, logPartnerExpense, partnerExpenseWeeklySum } from "./lifecycle/partner-ledger";
export { partnerValueRows, recomputePartnerGrades, pendingCDecisions, resolveCDecision, hasUngradedPartners, type PartnerValueRow, type CDecision } from "./lifecycle/partner-value";
export { createCertRequest, bookCertRequest, deliverCertRequest, declineCertRequest, sweepCertRequests, certLinkToken, resolveCertLink, getCertPageData, type CreateCertRequestInput, type CertPageData, type CertPageZone } from "./lifecycle/cert-request";
export { generateQuarterlyPartnerReports, duePartnerEmailTouches, getPartnerReportPageData, resolvePartnerReportLink, internalQuarterlyRanking, freshQuarterlyReportCount, type PartnerReportPayload, type PartnerReportPage, type QuarterlyRanking, type DuePartnerEmailTouch } from "./lifecycle/partner-report";
export { buildMobilizationBlitz, pendingBlitzApprovals, approveBlitzCampaign, blitzWeekStats, type BlitzResult, type PendingBlitz, type BlitzWeekStats } from "./lifecycle/mobilization-blitz";
export { runFillSweep, fillWeekStats, pendingFillApprovals, approveFillPlay, type FillSweepResult, type FillWeekStats, type PendingFillApproval } from "./lifecycle/slow-week-fill";
export { gatherValuationInputs, recordValuationSnapshot, listValuationSnapshots } from "./lifecycle/valuation";
export { createBlitzTieIns, listActiveTerritories, blitzCanvassStats, resolveBoostCard, dueBoostCards, setMarketingConsent } from "./lifecycle/blitz-tie-ins";
export { upsertMaterialLeftover, confirmNoLeftovers, reconcileJobMaterials, dueLeftoverPrompts, resolveMaterialReturn } from "./lifecycle/materials-reconcile";
export { markLeadLostWithIntel, findOrCreateCompetitor, marketPricingSummary, LOST_REASONS, type LostReason, type MarketPricingArtifact } from "./lifecycle/price-intel";
export { upsertCanvassKnock, isCanvassManager, isCanvassRepActive, type CanvassKnockUpsert } from "./lifecycle/canvass-knock";
export { unlockAchievements, listAchievementKeys } from "./lifecycle/canvass-achievement";
export { createChallenge, acceptChallenge, setChallengeStatus, listChallenges, standingsFor, settleDueChallenges, type ChallengeRow, type CreateChallengeArgs } from "./lifecycle/canvass-challenge";
export { createManualSpiff, listSpiffs, markSpiffPaid, createSettlementSpiffs, type SpiffRow, type ManualSpiffArgs } from "./lifecycle/canvass-spiff";
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
export { recordReferralPayment, approveReferralPayment, REFERRAL_FEE_APPROVAL_TASK_KEY } from "./lifecycle/referral-payment";
export { recomputeJobActualCost, saveParsedSupplierInvoice, getDocumentR2Key, matchSupplierInvoiceJob, markSupplierInvoiceParseFailed, getMaterialOrderSnapshot, saveGuardedSupplierInvoice, listUnmatchedSupplierInvoices, listSupplierInvoicesForJob } from "./lifecycle/supplier-invoice";
export { createCreditRequest, setCreditRequestSent, listOpenSentCreditRequests, markCreditRequestCredited, getCreditRecoverySummary, listDraftedCreditRequests } from "./lifecycle/credit-request";
export { markEsignBySubmission } from "./lifecycle/esign";
export { startInspectionForLead, startInspectionByAddress, ingestInspectionMedia, completeInspection, getInspectionProgress, getInspectionScope, getActiveInspectionForLead, type InspectionProgress } from "./lifecycle/inspection";
export { ensureInspectionChecklists } from "./lifecycle/inspection-checklist";
export { addInspectionFinding, confirmInspectionFinding, dismissInspectionFinding, setInspectionZoneGrade, listUnsupportedActionZones, suggestFindingFromChecklistMedia } from "./lifecycle/inspection-findings";
export { approveInspection, publishInspection, setInspectionNarrative, setZoneSummaries } from "./lifecycle/inspection-approval";
export { applyFriendRule, issueRepairCredit, applyRepairCreditToEstimate, creditCheckinsDue, recordCreditCheckin, expireLapsedCredits, type CreditCheckinDue } from "./lifecycle/repair-credit";
export { ensureRecordLink, resolveRecordLink, recordLinkToken, getRecordPageData, getRecordComparison, type RecordPageData, type RecordPageZone, type RecordComparison } from "./lifecycle/record-page";
export { getBaselinedProperties, baselineCoverageGaps, type BaselinedProperty } from "./lifecycle/inspection-baseline";
export { proposeStormReinspectBatch, approveStormReinspectBatch, dismissStormReinspectBatch, markStormBatchSent, listOpenStormBatches, unlinkedReinspections, stormSwathSignature, type StormSwathInput } from "./lifecycle/storm-reinspect";
export { ensureProductionPhaseTemplates, instantiateProductionPhases, ingestProductionMedia, reopenPhaseForQcFailure, listTriageMedia, getPhaseProgressForJob } from "./lifecycle/production-phase";
export { setPhotoCustomerSafe, doubleGatedPhotosForPhase, recordProductionUpdate, countUpdatesSentToday, hoUpdateGaps, deliveryNoticeGaps, statusGalleryForJob } from "./lifecycle/production-updates";
export { submitCrewEodReport, eodGaps } from "./lifecycle/crew-eod";
export { paceLagPhases, silentCrewDays, lateCrewAppointments, reportProductionBlocker, listOpenBlockers, resolveProductionBlocker, attachBlockerChangeOrder, recordMunicipalInspection, inspectionGateViolations, phaseEvidenceGaps, waitingInspectionGates } from "./lifecycle/production-detectors";
export { scheduleRelationshipTouch, schedulePartnerTouch, markTouchSent, markTouchSuppressed, listDueTouches, governorCapViolations } from "./lifecycle/relationship-touch";
export {
  enrollCompletedJobs, extendStandingCadence, holdDuePrintTouches,
  dueCadenceTextTouches, enrollmentGaps, cadenceSilenceViolations,
  jobHasActiveEnrollment, CADENCE_TEXT_PROGRAMS, type DueCadenceTouch,
} from "./lifecycle/relationship-enrollment";
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
export { ensurePriceBook, ensureTierProducts, tierProductsNeedingCosts, getCurrentPriceBook, getCurrentPriceBookTx, applyPriceBookVersion, deriveCostDriftDiff, MarginFloorConfirmationRequiredError, type PriceBookChange, type UnderFloorEntry } from "./lifecycle/price-book";
export { createEstimateFromMeasurement, draftLeadEstimateIfReady, refreshLeadEstimateDraft, resolveEstimateDelivery, setEstimateStatus } from "./lifecycle/estimate";
export { getLeadArtifacts, type LeadArtifacts } from "./lifecycle/lead-artifacts";
export { recordLeadDocument, listLeadDocuments, type LeadDocumentRow } from "./lifecycle/lead-documents";
export { getLeadDocumentForParse, getDocumentForParse, upsertUploadedMeasurement, setDocumentParseStatus, getDocumentParseSummaries, getDocumentForView } from "./lifecycle/lead-documents";
export { saveSketchMeasurement, type SketchScope, type SaveSketchMeasurementResult } from "./lifecycle/measurement";
export { computeTenantUsage, recordUsageSnapshot } from "./lifecycle/usage";
export { setCallDuration, recordVoiceCallReport, setLeadVoiceCallId, getLeadByVoiceCallId } from "./lifecycle/voice";
export { beginAgentRun, completeAgentRun, recordAgentRun, withAgentRun, listAgentActivity, listAgentActivityForDay, markStaleRunsTimedOut, listRunningRuns, loadAgentCoverageWindow, type AgentRunStatus, type AgentActivityRow, type RunningRunRow } from "./lifecycle/agent-run";
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
export { isDemoTenant, __clearDemoTenantCache } from "./lifecycle/demo-tenant";
export { ensureEstimateLink, resolveEstimateLink, setEstimateSelection, estimateLinkToken, getEstimatePageData } from "./lifecycle/estimate-page";
export { beginEstimateAcceptance, recordEstimateSigned, recordEstimateDeposit, estimateAcceptanceState, installWeekOptions, setRequestedInstallWeek, type BeginAcceptanceResult } from "./lifecycle/estimate-accept";
export { recordEstimateEvent, listEstimateEvents, raceOutcomeRows, closeRateRows, ESTIMATE_EVENT_KINDS, type EstimateEventKind } from "./lifecycle/estimate-telemetry";
export { attachEstimateVideo, videosForEstimate, videoBatchQueue, ownerVideoDeliveryQueue, parseOwnerVideoConfigRow, type VideoBatchEntry, type VideoDeliveryEntry } from "./lifecycle/estimate-video";
export { ensureEstimateFollowupDrip, ESTIMATE_FOLLOWUP_DRIP_KEY } from "./lifecycle/estimate-followup";
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
export { upsertClaim, getClaimForJob, getAdjusterAppointmentForJob, bookAdjusterMeeting, attachOrCreateLeadClaim, attachOrCreateClaim, type ClaimRow, type AdjusterAppointment, type BookAdjusterMeetingInput } from "./lifecycle/claim";
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
export { leadSourceSummary, referredRevenueByPerson } from "./lifecycle/lead-source-analytics";
export { getCalibrationInputs } from "./lifecycle/lead-calibration";
export { createSaleNoContractAlerts, createPinLockoutAlert, listAlerts, markAlertRead, markAllAlertsRead, readKnockForAlert, activeManagerIds, type AlertRow } from "./lifecycle/canvass-alert";
export {
  recordMoveSignal, confirmMove, dismissMove, pendingMoveVerifications,
  registerWarrantyTransfer, getWarrantyTransferOffer, createMoveLeadOnReply,
  movePlayGaps, transfersMissingRecord,
  type MoveSignalResult, type RegisterTransferResult,
} from "./lifecycle/move-play";
export { startMembershipCheckout, activateMembershipFromCheckout, cancelMembership, maintenanceMrrCents, membershipProgramUsed, activeMemberCustomerIds } from "./lifecycle/membership";
export { setPropertyRoofMaterial, confirmPropertyRoofType } from "./lifecycle/roof-material";
export { setDocumentNote, listJobPhotoNotes } from "./lifecycle/document-notes";
export { importAccuLynxData, type AccuLynxJobRecord, type AccuLynxContact, type AccuLynxImportResult } from "./lifecycle/acculynx-import";
export { scoreTenantTurf, emitTurfCampaigns, type ScoredNeighborhood } from "./lifecycle/turf-score";
export { spotterPrecisionReport } from "./lifecycle/spotter-precision";
export { runMaintenanceOfferSweep, maintenanceChurnStats, type MaintenanceSweepResult, type MaintenanceChurnStats } from "./lifecycle/maintenance-offers";
export { runMaintenanceVisitSweep, sendDueVisitReports, getVisitReport, type VisitSweepResult, type ReportSendResult, type VisitReportData } from "./lifecycle/maintenance-visits";
export { createScan, listScans, type CreateScanArgs, type ScanRow } from "./lifecycle/canvass-scan";
export { insertPings, listPingsForDay, type PingPoint } from "./lifecycle/canvass-ping";
export { importAccuLynxAttachments, type AttachmentJobBundle, type AttachmentDeps, type AttachmentResult } from "./lifecycle/acculynx-attachments-import";
export { DrizzleOrchestratorStore } from "./orchestrator/store";
export { loadEventsForDay, upsertDailyMetrics, getDailyMetrics, upsertQueueItem, listQueue } from "./command-center/store";
export { dailyMetrics, exceptionQueue } from "./schema/command-center";
