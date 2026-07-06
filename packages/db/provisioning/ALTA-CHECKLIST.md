# Alta Launch — Gather Worksheet

Fill each value below, drop it into `alta.json` (copy of `alta.example.json`, git-ignored),
then run the dry-run — it will tell you exactly what's still missing before you commit.

## Values to collect

| # | Value | Where to get it | `alta.json` field |
|---|---|---|---|
| 1 | **Alta's Clerk org id** (`org_…`) | Clerk dashboard → Organizations → Alta → copy the ID. If Alta isn't in Clerk yet, create the org (and invite the owner) first. | `clerkOrgId` |
| 2 | **Owner Clerk user id** (`user_…`) | Clerk dashboard → Users → Alta's owner → copy the ID. | `owner.clerkUserId` |
| 3 | **Owner name + email** | Alta's owner. | `owner.name`, `owner.email` |
| 4 | **CO state license #** | Alta's CO Secretary of State / contractor registration. | `licenses[0].licenseNumber` |
| 5 | **Denver-metro city registrations** (Denver, Aurora, …) | Each city's contractor licensing office. One row per jurisdiction they work in. | `licenses[1..].licenseNumber` |
| 6 | **Twilio from-number** (`+1303…`) | Twilio Console → Phone Numbers (Alta's number). *Optional now — leave the seam dormant and wire later.* | `twilio.fromNumber` |

## Secrets — never go in the JSON (env only, at commit time)

| Env var | Where | Needed for |
|---|---|---|
| `DATABASE_ADMIN_URL` | Neon dashboard → owner/direct connection string | writing to prod |
| `INTEGRATION_SECRET_KEY` | your prod secret store (base64, 32 bytes) | sealing the Twilio token |
| `PROVISION_TWILIO_ACCOUNT_SID` / `PROVISION_TWILIO_AUTH_TOKEN` | Twilio Console → Alta's subaccount | *only if* wiring Twilio now |

## Run it

```bash
# 1. Copy the template (git-ignored):
cp packages/db/provisioning/alta.example.json packages/db/provisioning/alta.json
#    …edit alta.json with the values above…

# 2. Dry run — prints the plan + a checklist of anything still unfilled (writes nothing):
pnpm --filter @savvy/db db:provision provisioning/alta.json

# 3. Commit — creates Alta as tenant #2 (refuses if the dry-run showed unfilled fields):
DATABASE_ADMIN_URL="postgres://<neon-owner>:<pw>@<project>.<region>.aws.neon.tech/savvy?sslmode=require" \
INTEGRATION_SECRET_KEY=<base64-32> \
  pnpm --filter @savvy/db db:provision provisioning/alta.json --commit
#    add PROVISION_TWILIO_ACCOUNT_SID + PROVISION_TWILIO_AUTH_TOKEN to wire Twilio too.
```

The commit run writes `alta.complete.json` (the provisioning artifact + wall-clock — your onboarding baseline to beat) and prints `tenant #: <id> (created)`.

## Then (post-launch, from the dormant-seam list)
- Connect QuickBooks + Stripe (Nango / Stripe keys) → cells 8 checks go from *skip* to green.
- Carrier 10DLC registration for Alta's number → cell 6 deliverability.
- Attach the real CO SB38 DocuSeal template id → cell 17b.
