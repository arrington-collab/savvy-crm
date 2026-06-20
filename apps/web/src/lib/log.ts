import { formatLog, type LogContext } from "@savvy/core";

/**
 * Thin structured-logging wrapper. Emits one JSON line per call to the matching
 * console method; Vercel captures stdout/stderr. The pure formatter lives in
 * @savvy/core (unit-tested); this file only supplies the timestamp + console IO.
 */
export const log = {
  info(msg: string, ctx?: LogContext) {
    console.log(formatLog("info", msg, ctx, new Date().toISOString()));
  },
  warn(msg: string, ctx?: LogContext) {
    console.warn(formatLog("warn", msg, ctx, new Date().toISOString()));
  },
  error(msg: string, ctx?: LogContext) {
    console.error(formatLog("error", msg, ctx, new Date().toISOString()));
  },
};
