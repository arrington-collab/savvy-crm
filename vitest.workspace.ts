// Vitest runs package unit/integration tests and web route handler unit tests.
// apps/web e2e tests use Playwright (tests/e2e/*.spec.ts) and are separate.
export default ["packages/*", "apps/web"];
