/** The four exception actions a verified owner can trigger by SMS/voice in v1. */
export type SageActionKind = "approve_estimate" | "send_invoice" | "complete_task" | "send_credit";

/** A parsed inbound Sage command. Free-text falls through to the cited-answer path. */
export type SageCommand =
  | { type: "action"; n: number }
  | { type: "detail"; n: number }
  | { type: "confirm"; ok: boolean }
  | { type: "help" }
  | { type: "verify"; code: string }
  | { type: "freetext"; text: string };

/**
 * One addressable line in a numbered digest. Built where the underlying entity
 * ids are still available (the ExceptionQueue normalizes these away), then
 * persisted per-send so an inbound "reply N" resolves deterministically.
 */
export type SageDigestItem = {
  kind: string; // ExceptionKind | task-exception kind
  entityId: string; // estimateId | invoiceId | taskId | creditId
  jobId: string | null;
  title: string;
  detail: string;
  action: SageActionKind | null;
  confirmAmountCents: number | null;
};
