# Savvy — Data Model

Postgres + Drizzle. **Every table carries `tenant_id uuid not null` and is protected by RLS.** IDs are uuid v7 (sortable). Timestamps `created_at`/`updated_at` on every table. Soft-delete with `deleted_at` where it matters.

## Multi-tenancy / RLS (the rule everything depends on)
- Each request resolves `tenantId` from the Clerk active org, then sets it on the connection: `SET app.tenant_id = '<uuid>'`.
- Every table has an RLS policy:
  ```sql
  alter table <t> enable row level security;
  create policy tenant_isolation on <t>
    using (tenant_id = current_setting('app.tenant_id')::uuid)
    with check (tenant_id = current_setting('app.tenant_id')::uuid);
  ```
- A test asserts: seed two tenants, set context to tenant A, confirm tenant B's rows are invisible to select/update/delete. Keep green.

## Enums
- `job_type`: retail | insurance | repair | commercial
- `job_stage`: lead → inspected → estimate → approved → production → closeout → billing → complete → lost
- `task_status`: pending | in_progress | blocked | done | skipped
- `automation_level`: full | partial | manual
- `agent`: orchestrator | comms | scheduling | finance | claims
- `comm_channel`: call | sms | email
- `comm_direction`: inbound | outbound

## Core entities

**tenant** — the roofing company. `id, name, revenue_band, plan_price, settings(jsonb), created_at`. Root of isolation.

**user** — `id, tenant_id, clerk_user_id, name, email, role(owner|admin|rep|crew|office), created_at`. Roles gate UI, not tenancy.

**customer** — homeowner. `id, tenant_id, name, email, phone, billing_address, created_at`.

**property** — `id, tenant_id, customer_id→customer, address, lat, lng, parcel_id, roof_sqft, roof_pitch, year_built, stories, notes`.

**lead** — `id, tenant_id, customer_id?(nullable until converted), property_id?, source, status(new|contacted|qualified|booked|won|lost), score, storm_event_id?, assigned_user_id?, created_at`. Converts into a job.

**job** — the core record. `id, tenant_id, customer_id→customer, property_id→property, type(job_type), stage(job_stage), value_estimate, value_final, assigned_user_id?, lead_id?, opened_at, closed_at, stage_entered_at`. `stage_entered_at` powers days-in-stage analytics.

**job_task** — instances of the 212-task lifecycle on a job. `id, tenant_id, job_id→job, key(stable task identifier), title, phase, owner_agent(agent), automation_level, status(task_status), due_at, completed_at, assignee_user_id?, payload(jsonb)`. The Orchestrator creates/advances these.

**agent_run** — record of a workflow execution. `id, tenant_id, agent(agent), job_id?, task_key?, inngest_run_id, status(running|ok|error), model_used?, tokens?, cost_cents?, started_at, finished_at, error?`. Powers observability + per-tenant cost tracking.

**communication** — `id, tenant_id, job_id?, customer_id?, channel(comm_channel), direction(comm_direction), to, from, body, recording_url?, transcript?, twilio_sid?, ai_handled(bool), created_at`.

**appointment** — `id, tenant_id, job_id→job, type(inspection|crew|cm), starts_at, ends_at, assignee_user_id?, status(scheduled|done|canceled|no_show), gcal_event_id?`.

**estimate** — `id, tenant_id, job_id→job, source(roofr|manual|carrier), status(draft|sent|accepted), line_items(jsonb), subtotal, tax, total, esx_url?, created_at`.

**invoice** — `id, tenant_id, job_id→job, number, status(draft|sent|paid|overdue|void), line_items(jsonb), amount_due, amount_paid, due_at, stripe_invoice_id?, qbo_id?`.

**payment** — `id, tenant_id, invoice_id→invoice, method(card|ach|check|insurance|mortgage), amount, stripe_payment_id?, received_at`.

**document** — `id, tenant_id, job_id?, customer_id?, kind(photo|measurement|contract|lien_waiver|cert|evidence|other), r2_key, filename, mime, size_bytes, source(companycam|savvy|upload), shared_with(jsonb), created_at`. Storage metered per tenant via sum(size_bytes).

**measurement** — `id, tenant_id, property_id→property, provider(roofr), report_url, areas(jsonb), pitch, ordered_by_user_id?, cost_cents, created_at`.

**audit_log** — `id, tenant_id, user_id?, agent?, entity_type, entity_id, action, diff(jsonb), created_at`.

## Insurance add-on (stub now, wire later — SupplementIQ)
**carrier** `id, tenant_id?, name, profile(jsonb)` (global profiles may be tenant-null/shared) ·
**claim** `id, tenant_id, job_id→job, carrier_id→carrier, claim_number, adjuster, acv, rcv, status` ·
**supplement** `id, tenant_id, claim_id→claim, line_items(jsonb), status, amount`.
The KB (kb_chunk/scope_chunk + vector search) lives in the add-on, not core. Core just keeps the FK seams (`job.type='insurance'`, `claim.job_id`).

## Indexing / notes
- Index `tenant_id` on every table; composite `(tenant_id, stage)` on job, `(tenant_id, status)` on lead/invoice, `(tenant_id, job_id)` on job_task/communication.
- `job.stage_entered_at` + a stage-history table (or audit_log) for days-in-stage and velocity reports.
- Money in integer cents. Phone in E.164. Addresses normalized.
- `payload`/`settings`/`line_items` as jsonb but validate with zod at the edge (`packages/core`).
