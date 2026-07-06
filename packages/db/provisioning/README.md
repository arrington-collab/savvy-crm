# Tenant Provisioning Runbook (Cell 20)

One idempotent script stands up a new tenant end-to-end. Built so onboarding a
tenant (the acquisition thesis in miniature) is repeatable and timed, not manual.

## What it does

`provisionTenant` (in `src/lifecycle/provision-runbook.ts`) runs these steps,
each **idempotent** (safe to re-run):

1. **Tenant** — find-or-create by Clerk org; set timezone (**America/Denver**), digest times, break-glass rules.
2. **Owner** — upsert the owner user.
3. **Price book** — seed the default price book if empty.
4. **License matrix** — insert each jurisdiction license (cell 17a) that isn't already present.
5. **Contract templates** — insert the CO SB38 template (cell 17b); `docuseal_template_id` stays null until the owner/lawyer attaches the real DocuSeal template.
6. **Registry + tenant_task_config** — seed the global task registry; upsert per-tenant task enable/mode.
7. **Golden-set message templates** — insert any provided templates by key.
8. **Twilio + A2P** — *only when a Twilio secret is supplied via env* (sealed before storage); otherwise left dormant.
9. **Dormant-seam inventory** — reports every third-party seam (financing, PostGrid, QuickBooks, Stripe, DocuSeal, Roofr, CompanyCam) and exactly what activating each requires.

It returns a `provisioning.complete` artifact (steps + seam inventory + wall-clock).

## Secrets — zero literals

The committable config JSON carries **no secrets**. The only secret (the Twilio
auth token) is read from env at execution and sealed by the DB layer before it
touches Postgres. It is never logged or written to the artifact.

Required env for a full commit run:

| Env var | Purpose |
|---|---|
| `DATABASE_ADMIN_URL` | admin DB connection |
| `INTEGRATION_SECRET_KEY` | base64 32-byte key that seals the Twilio token |
| `PROVISION_TWILIO_ACCOUNT_SID` | Twilio subaccount SID (optional — omit → Twilio dormant) |
| `PROVISION_TWILIO_AUTH_TOKEN` | Twilio auth token (optional — omit → Twilio dormant) |

## Owner-provided inputs (why execution is owner-run)

The following are **real-world inputs the owner supplies at execution** — copy
`alta.example.json` to `alta.json` (git-ignored) and fill them in:

- Clerk org id + owner Clerk user id / email
- CO license numbers (state + Denver-metro city registrations)
- Twilio subaccount SID + auth token + from-number (env), and the carrier 10DLC
  brand/campaign registration (owner-performed — cell 6 break-glass card has the steps)
- QuickBooks / Stripe accounts (dormant seams — activate later for cell 8)

## Run it

```bash
# 1. Dry run — prints the plan, writes nothing:
pnpm --filter @savvy/db db:provision provisioning/alta.json

# 2. Execute — creates/reconciles the tenant and writes alta.complete.json:
INTEGRATION_SECRET_KEY=<base64-32> \
PROVISION_TWILIO_ACCOUNT_SID=AC... PROVISION_TWILIO_AUTH_TOKEN=... \
pnpm --filter @savvy/db db:provision provisioning/alta.json --commit
```

The wall-clock printed on the commit run is the onboarding baseline to beat.

## Files

- `alta.example.json` — committed template (no secrets). Copy to `alta.json` (git-ignored) and fill in.
- `*.json` (real configs) and `*.complete.json` (artifacts) are git-ignored — they carry real tenant IDs.
