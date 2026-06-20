export type LogLevel = "info" | "warn" | "error";

/** Optional structured context. Ids only — never PII. */
export type LogContext = {
  requestId?: string;
  tenantId?: string;
  route?: string;
  [key: string]: string | number | boolean | undefined;
};

/**
 * Format a single structured log line as JSON. Pure: `time` is passed in
 * (ISO string) so the function is deterministic and testable. Reserved
 * level/msg/time fields always win over ctx.
 */
export function formatLog(
  level: LogLevel,
  msg: string,
  ctx: LogContext | undefined,
  time: string,
): string {
  return JSON.stringify({ ...(ctx ?? {}), level, msg, time });
}
