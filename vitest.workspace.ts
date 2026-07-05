// Vitest runs package unit/integration tests only. apps/web uses Playwright
// (tests/e2e/*.spec.ts) which must NOT be picked up by vitest.
export default ["packages/*"];
