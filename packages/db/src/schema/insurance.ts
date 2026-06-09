// SupplementIQ add-on tables — stubbed per DATA-MODEL.md. NOT created in Phase 0.
// Uncomment + add tenant_isolation() when wiring Phase 9. The core keeps the
// FK seams: job.type='insurance' and (future) claim.job_id -> job.id.
//
// export const carrier = pgTable("carrier", { ... });   // tenant nullable (shared profiles)
// export const claim = pgTable("claim", { ... });        // claim.jobId -> job.id
// export const supplement = pgTable("supplement", { ... });
export {};
