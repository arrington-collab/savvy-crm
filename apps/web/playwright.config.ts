import { defineConfig } from "@playwright/test";

// TEST_TENANT_ID is exported by the run wrapper (after create-tenant.ts writes
// the fresh tenant). The webServer (next dev) must start with it so the
// dashboard's getTenantId() resolves to the e2e tenant.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  // Pin the browser timezone to the e2e tenant's default finance.timezone (America/Phoenix, no DST).
  // The schedule specs derive UTC<->civil-time offsets assuming this tz; do not remove without updating them.
  use: { baseURL: "http://localhost:3000", timezoneId: "America/Phoenix" },
  webServer: {
    command: "./node_modules/.bin/next dev -p 3000",
    url: "http://localhost:3000/api/inngest",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      TEST_MODE: "1",
      VAPI_WEBHOOK_SECRET: "test-vapi-secret",
      INBOUND_EMAIL_SECRET: "test-inbound-secret",
      TEST_TENANT_ID: process.env.TEST_TENANT_ID ?? "",
      INNGEST_DEV: "1",
      LITELLM_BASE_URL: `http://localhost:${process.env.AI_STUB_PORT ?? "4010"}/v1`,
      LITELLM_API_KEY: "sk-stub",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://savvy_app:savvy_app@localhost:5432/savvy",
      DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/savvy",
      APP_BASE_URL: "http://localhost:3000",
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
    },
  },
});
