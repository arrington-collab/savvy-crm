import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN, // inert when unset
  tracesSampleRate: 0.1,
  enabled: !!process.env.SENTRY_DSN,
});
