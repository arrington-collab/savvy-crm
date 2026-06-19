/**
 * Resolve a required secret from the environment.
 * - Returns process.env[name] when set.
 * - Throws in production when unset (never silently fall back to a public constant).
 * - Outside production, returns opts.devFallback, or a derived "dev-<name>" placeholder.
 *
 * Lives in @savvy/core because it is the only package both apps/web and
 * packages/agents import, and reading process.env here keeps it trivially testable.
 */
export function requireSecret(name: string, opts?: { devFallback?: string }): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`Missing required secret: ${name}`);
  }
  return opts?.devFallback ?? `dev-${name.toLowerCase()}`;
}
