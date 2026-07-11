import { AGENT } from "./enums";

const STATUS_VALUES = ["running", "ok", "error", "skipped"] as const;
type ActivityStatus = (typeof STATUS_VALUES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export interface ActivityQuery {
  limit: number;
  before?: Date;
  agent?: string;
  status?: string;
  jobId?: string;
}

/**
 * Pure parser for /api/activity + /activity page query params. Untrusted raw
 * strings in, safe/validated values out — never throws, never lets a bogus
 * param (bad enum, bad date, non-numeric limit, non-uuid job) reach the DB
 * query layer where it would blow up as a 500.
 */
export function parseActivityQuery(get: (key: string) => string | null | undefined): ActivityQuery {
  const result: ActivityQuery = { limit: DEFAULT_LIMIT };

  const limitRaw = get("limit");
  if (limitRaw != null) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n >= 1) {
      result.limit = Math.min(n, MAX_LIMIT);
    }
  }

  const beforeRaw = get("before");
  if (beforeRaw != null) {
    const before = new Date(beforeRaw);
    if (!isNaN(before.getTime())) {
      result.before = before;
    }
  }

  const agentRaw = get("agent");
  if (agentRaw != null && (AGENT as readonly string[]).includes(agentRaw)) {
    result.agent = agentRaw;
  }

  const statusRaw = get("status");
  if (statusRaw != null && (STATUS_VALUES as readonly string[]).includes(statusRaw)) {
    result.status = statusRaw as ActivityStatus;
  }

  const jobRaw = get("job");
  if (jobRaw != null && UUID_RE.test(jobRaw)) {
    result.jobId = jobRaw;
  }

  return result;
}
