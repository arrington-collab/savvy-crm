import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { rateLimitKey, RATE_LIMITS, type RateBucket } from "@savvy/core";
import { log } from "./log";

// Lazily-built singletons; only created when BOTH Upstash env vars are present.
let redis: Redis | null = null;
const limiters = new Map<RateBucket, Ratelimit>();

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // disabled mode
  redis = new Redis({ url, token });
  return redis;
}

function getLimiter(bucket: RateBucket): Ratelimit | null {
  const r = getRedis();
  if (!r) return null;
  const existing = limiters.get(bucket);
  if (existing) return existing;
  const { limit, windowSeconds } = RATE_LIMITS[bucket];
  const limiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s` as `${number} s`),
    prefix: "savvy-rl",
  });
  limiters.set(bucket, limiter);
  return limiter;
}

/**
 * Throttle a request. FAIL-OPEN by design: when Upstash is unconfigured or the
 * limiter errors, return { ok: true } so a limiter outage never breaks lead
 * capture or crew login. The throttle only exists once Upstash env is set in prod.
 */
export async function checkRateLimit(bucket: RateBucket, id: string): Promise<{ ok: boolean }> {
  try {
    const limiter = getLimiter(bucket);
    if (!limiter) return { ok: true }; // disabled mode (no env)
    const { success } = await limiter.limit(rateLimitKey(bucket, id));
    return { ok: success };
  } catch (err) {
    log.warn("rate-limit check failed (failing open)", { route: bucket, msg: String(err) });
    return { ok: true };
  }
}

/** First hop of x-forwarded-for, or "unknown". Vercel sets this header. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (!xff) return "unknown";
  return xff.split(",")[0]?.trim() || "unknown";
}
