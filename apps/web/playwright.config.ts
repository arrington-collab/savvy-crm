import { defineConfig, type Project } from "@playwright/test";

// TEST_TENANT_ID is exported by the run wrapper (after create-tenant.ts writes
// the fresh tenant). The webServer (next dev) must start with it so the
// dashboard's getTenantId() resolves to the e2e tenant.
//
// DEMO_TENANT_ID (optional) is exported by the run wrapper after seed-demo-tenant.ts
// seeds the ONE isolated demo tenant. When set, a SECOND webServer (:3001) boots with
// TEST_TENANT_ID pointed at that demo tenant, and the `demo` project runs
// demo-tenant.spec.ts against it. This keeps the full demo pipeline (which mints
// costed jobs + this-month invoices) OUT of the shared e2e tenant, where it would
// break money-console.spec's "GM · MTD est —" (no-instrumented-margin) assertion.
const DEMO_TENANT_ID = process.env.DEMO_TENANT_ID ?? "";

// Shared browser + webServer env — identical for both servers except port/tenant/dist.
const sharedServerEnv = {
  TEST_MODE: "1",
  VAPI_WEBHOOK_SECRET: "test-vapi-secret",
  INBOUND_EMAIL_SECRET: "test-inbound-secret",
  INNGEST_DEV: "1",
  LITELLM_BASE_URL: `http://localhost:${process.env.AI_STUB_PORT ?? "4010"}/v1`,
  LITELLM_API_KEY: "sk-stub",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://savvy_app:savvy_app@localhost:5432/savvy",
  DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/savvy",
  TWILIO_FROM: "+15555550000",
  // Phase 6B closeout e-sign: leave DOCUSEAL_API_KEY unset so the send uses the
  // fake gateway (same fail-soft pattern as estimate signing). The template ids
  // just need to be non-empty so sendForSignature doesn't short-circuit on
  // "no_template". No webhook secret => verifyWebhook skips HMAC in dev.
  DOCUSEAL_TEMPLATE_LIEN_WAIVER: "1",
  DOCUSEAL_TEMPLATE_CERT: "2",
  DOCUSEAL_TEMPLATE_CHANGE_ORDER: "3",
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "test-maps-key",
};

const projects: Project[] = [
  {
    name: "app",
    // The whole suite EXCEPT demo-tenant.spec.ts, against the shared e2e tenant on :3000.
    testIgnore: "**/demo-tenant.spec.ts",
    use: { baseURL: "http://localhost:3000" },
  },
];

const webServer: NonNullable<Parameters<typeof defineConfig>[0]["webServer"]> = [
  {
    command: "./node_modules/.bin/next dev -p 3000",
    url: "http://localhost:3000/api/inngest",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...sharedServerEnv,
      TEST_TENANT_ID: process.env.TEST_TENANT_ID ?? "",
      APP_BASE_URL: "http://localhost:3000",
    },
  },
];

// Only wire the demo server + project when a demo tenant has been seeded — so a plain
// local `playwright test` (no DEMO_TENANT_ID) neither boots a second server nor collects
// demo-tenant.spec.ts. In CI the run wrapper always seeds it and exports DEMO_TENANT_ID.
if (DEMO_TENANT_ID) {
  projects.push({
    name: "demo",
    testMatch: "**/demo-tenant.spec.ts",
    use: { baseURL: "http://localhost:3001" },
  });
  webServer.push({
    command: "./node_modules/.bin/next dev -p 3001",
    url: "http://localhost:3001/api/inngest",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...sharedServerEnv,
      TEST_TENANT_ID: DEMO_TENANT_ID,
      APP_BASE_URL: "http://localhost:3001",
      // Separate build dir so the two concurrent `next dev` servers don't fight over `.next`.
      NEXT_DIST_DIR: ".next-demo",
    },
  });
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  // Pin the browser timezone to the e2e tenant's default finance.timezone (America/Phoenix, no DST).
  // The schedule specs derive UTC<->civil-time offsets assuming this tz; do not remove without updating them.
  use: { timezoneId: "America/Phoenix", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects,
  webServer,
});
