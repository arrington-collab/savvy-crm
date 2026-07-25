import type { DomainEvent } from "./events";
import type { EscalationHit } from "./escalations";

export interface AuditRecord {
  event: DomainEvent;
  agent: string;
  outcome: "handled" | "dead_letter" | "received";
  emitted: string[];
  error?: string;
}

export interface EscalationRecord extends EscalationHit {
  tenantId: string;
  correlationId: string;
  eventId: string;
  eventType: string;
}

export interface OrchestratorStore {
  /** Append-only dedupe: true if this (tenant, idempotencyKey) is new, false if seen. */
  insertEventIfNew(e: DomainEvent): Promise<boolean>;
  appendAudit(r: AuditRecord): Promise<void>;
  recordEscalation(r: EscalationRecord): Promise<void>;
  traceByCorrelation(tenantId: string, correlationId: string): Promise<AuditRecord[]>;
  listEscalations(tenantId: string): Promise<EscalationRecord[]>;
}

// In-memory backing for tests + the acceptance harness. The public arrays let
// tests assert on the recorded trace directly.
export class InMemoryStore implements OrchestratorStore {
  readonly audits: AuditRecord[] = [];
  readonly escalations: EscalationRecord[] = [];
  private seen = new Set<string>();

  private key(e: DomainEvent): string {
    return `${e.tenantId}:${e.idempotencyKey}`;
  }

  async insertEventIfNew(e: DomainEvent): Promise<boolean> {
    const k = this.key(e);
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }

  async appendAudit(r: AuditRecord): Promise<void> {
    this.audits.push(r);
  }

  async recordEscalation(r: EscalationRecord): Promise<void> {
    this.escalations.push(r);
  }

  async traceByCorrelation(tenantId: string, correlationId: string): Promise<AuditRecord[]> {
    return this.audits.filter((a) => a.event.tenantId === tenantId && a.event.correlationId === correlationId);
  }

  async listEscalations(tenantId: string): Promise<EscalationRecord[]> {
    return this.escalations.filter((e) => e.tenantId === tenantId);
  }
}
