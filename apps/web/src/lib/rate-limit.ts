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
  // Accept both naming schemes: UPSTASH_* (direct Upstash account) and
  // KV_REST_API_* (what the Vercel Marketplace "Upstash for Redis" integration
  // injects — same REST protocol, different env names).
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
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

// --- Tripwire counters (login PIN lockout) ---------------------------------
// A durable failure counter + lock, backed by the same Upstash instance as the
// rate limiter. FAIL-OPEN like checkRateLimit: if Redis is unconfigured/errors,
// the tripwire simply doesn't arm (the per-name rate limit still applies).

/** Increment a TTL'd counter; returns the new count (0 when Redis is off). */
export async function bumpFailure(key: string, ttlSeconds: number): Promise<number> {
  try {
    const r = getRedis();
    if (!r) return 0;
    const k = `savvy-tw:${key}`;
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, ttlSeconds);
    return n;
  } catch {
    return 0;
  }
}

/** True while a lock key is set. */
export async function isLocked(key: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    return (await r.get(`savvy-tw:${key}`)) != null;
  } catch {
    return false;
  }
}

/** Set a lock for ttlSeconds. */
export async function setLock(key: string, ttlSeconds: number): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.set(`savvy-tw:${key}`, "1", { ex: ttlSeconds });
  } catch {
    /* fail-open */
  }
}

/** Clear tripwire keys (on a successful login). */
export async function clearTripwire(...keys: string[]): Promise<void> {
  try {
    const r = getRedis();
    if (!r || keys.length === 0) return;
    await r.del(...keys.map((k) => `savvy-tw:${k}`));
  } catch {
    /* fail-open */
  }
}

/** First hop of x-forwarded-for, or "unknown". Vercel sets this header. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (!xff) return "unknown";
  return xff.split(",")[0]?.trim() || "unknown";
}
