/** Per-bucket throttle policy. The IO wrapper (apps/web) maps this onto Upstash. */
export const RATE_LIMITS = {
  leads: { limit: 10, windowSeconds: 60 },
  "crew-pin": { limit: 5, windowSeconds: 60 },
  canvass: { limit: 10, windowSeconds: 60 },
} as const;

export type RateBucket = keyof typeof RATE_LIMITS;

/** Build the Redis key for a throttle bucket + caller id (e.g. `${tenantKey}:${ip}`). */
export function rateLimitKey(bucket: RateBucket, id: string): string {
  return `${bucket}:${id}`;
}
