import type { VerificationTier, EvidenceStatus } from "../enums";

export type { EvidenceStatus };

/**
 * Evidence-check framework (see docs/superpowers/specs/task-registry.md).
 * The checker is never the doer: verification is deterministic SQL, external
 * reconciliation, or a *different* model — never the agent grading its own work.
 *
 * These live in @savvy/core (pure). The `db` handle is injected as a minimal
 * pg-Pool-shaped interface so core takes no dependency on @savvy/db (which
 * depends on core). The health sweep injects the admin pool at runtime.
 */

// A pointer a verification cites — a row id or external id, optionally linkable.
export interface EvidenceRef {
  type: string; // "communication" | "lead" | "invoice" | "agent_run" | ...
  ref: string; // row id / external id
  url?: string;
}

export interface EvidenceResult {
  status: EvidenceStatus;
  details: string;
  refs: EvidenceRef[];
}

export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Minimal read-only query interface (node-postgres Pool shape). Kept tiny so
 * core stays dependency-light; checks run parameterized SQL, never the ORM.
 */
export interface VerificationDb {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface EvidenceCtx {
  tenantId: string;
  db: VerificationDb;
  params: Record<string, unknown>;
  window: DateRange;
}

export type EvidenceCheck = (ctx: EvidenceCtx) => Promise<EvidenceResult>;

// A single binding: which registry check_key maps to which check, and its tier.
export interface CheckBinding {
  tier: VerificationTier;
  check: EvidenceCheck;
}
