import { and, eq, isNull } from "drizzle-orm";
import type { TaskMode, MessageChannel, A2pState } from "@savvy/core";
import { adminDb } from "../admin-client";
import { tenant } from "../schema/tenancy";
import { license, contractTemplate } from "../schema/compliance";
import { tenantTaskConfig } from "../schema/task-registry";
import { messageTemplate } from "../schema/comms";
import { ensureTenantForOrg, ensureUser } from "./provisioning";
import { ensurePriceBook, ensureTierProducts } from "./price-book";
import { upsertTwilioConnection, type TwilioSecret } from "./telephony";
import { setA2pRegistration } from "./a2p";
import { seedTaskRegistry } from "../../seeds/master-task-list";

// The Cell 20 provisioning runbook: one idempotent, dry-run-first script that
// stands up a new tenant end-to-end. Secrets NEVER live in the committable
// config — they arrive via `secrets` (the CLI reads them from env / the secret
// box). The Twilio auth token is sealed by upsertTwilioConnection before it
// touches the DB. Execution for a real tenant is owner-run because the
// licenses, price book, and Twilio/QB/Stripe accounts are real-world inputs.

const DEFAULT_TZ = "America/Denver";

export type ProvisionStepAction = "created" | "updated" | "skipped" | "planned";
export interface ProvisionStep {
  step: string;
  action: ProvisionStepAction;
  detail: string;
}

export interface DormantSeam {
  key: string;
  label: string;
  active: boolean;
  activate: string; // what turning it on requires
}

// Every third-party seam a tenant can light up later. Dormant by default (house
// rule): the tenant operates without them; the inventory records what each needs.
export const DORMANT_SEAMS: ReadonlyArray<Omit<DormantSeam, "active">> = [
  { key: "twilio", label: "Twilio SMS/voice + A2P 10DLC", activate: "Twilio subaccount + number + carrier 10DLC brand/campaign registration (cell 6 card)" },
  { key: "financing", label: "Consumer financing", activate: "owner selects a vendor (cell 11), then wire the FinancingProvider adapter" },
  { key: "postgrid", label: "PostGrid direct mail", activate: "PostGrid API key + per-lender letter templates (cell 16)" },
  { key: "quickbooks", label: "QuickBooks AR sync", activate: "Nango QuickBooks Online connection (cell 8 reconcile)" },
  { key: "stripe", label: "Stripe payments/payouts", activate: "Stripe keys via env/secret-box (cell 8 payout match)" },
  { key: "docuseal", label: "DocuSeal e-sign", activate: "DOCUSEAL_API_KEY + real contract template ids (cell 17b)" },
  { key: "roofr", label: "Roofr measurement", activate: "Roofr API key (cell 9 auto-order)" },
  { key: "companycam", label: "CompanyCam photos", activate: "Nango CompanyCam connection (photo QC ingest)" },
];

export interface TenantProvisionConfig {
  name: string;
  clerkOrgId: string;
  timezone?: string; // default America/Denver
  digestTimes?: string[];
  breakGlass?: { min_dollars: number; deadline_hours: number };
  owner: { clerkUserId: string; name: string; email: string };
  licenses: { state: string; city?: string | null; authority: string; licenseNumber: string; status?: string }[];
  contractTemplates?: { state: string; version?: number; name: string; clauses: string[]; status?: string }[];
  taskConfig?: { taskId: number; enabled?: boolean; mode?: TaskMode }[];
  messageTemplates?: { key: string; name: string; channel: MessageChannel; subject?: string; body: string; aiCapability?: string }[];
  // Twilio POINTERS only (from-number, A2P state). The secret is passed separately.
  twilio?: { fromNumber: string; a2p?: Partial<A2pState> };
}

export interface ProvisionSecrets {
  twilioSecret?: TwilioSecret; // read from env by the CLI; never committed
}

export interface ProvisionArtifact {
  status: "complete";
  tenantId: string;
  clerkOrgId: string;
  name: string;
  timezone: string;
  provisionedAt: string;
  steps: ProvisionStep[];
  dormantSeams: DormantSeam[];
}

export interface ProvisionResult {
  dryRun: boolean;
  tenantId: string;
  created: boolean;
  steps: ProvisionStep[];
  dormantSeams: DormantSeam[];
  artifact: ProvisionArtifact;
  warnings?: string[]; // unresolved config fields (placeholders / missing) — surfaced on dry-run
}

const hasPlaceholder = (s: string | null | undefined): boolean => !!s && /REPLACE/i.test(s);
const looksLikeEmail = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/**
 * Preflight: lists config fields that still carry a `REPLACE` placeholder, are
 * empty-but-required, or malformed (owner email). Empty list = ready to commit.
 * Used to WARN on dry-run and to REFUSE a --commit run (so a half-filled
 * provisioning input can never create a broken tenant #2).
 */
export function findUnresolvedConfigFields(config: TenantProvisionConfig): string[] {
  const issues: string[] = [];
  if (!config.name?.trim() || hasPlaceholder(config.name)) issues.push("name");
  if (!config.clerkOrgId?.trim() || hasPlaceholder(config.clerkOrgId)) issues.push("clerkOrgId");
  if (!config.owner?.clerkUserId?.trim() || hasPlaceholder(config.owner.clerkUserId)) issues.push("owner.clerkUserId");
  if (!config.owner?.email || hasPlaceholder(config.owner.email) || !looksLikeEmail(config.owner.email)) issues.push("owner.email");
  if (!config.licenses?.length) {
    issues.push("licenses (at least one required)");
  } else {
    config.licenses.forEach((l, i) => {
      if (!l.licenseNumber?.trim() || hasPlaceholder(l.licenseNumber)) issues.push(`licenses[${i}].licenseNumber`);
    });
  }
  if (config.twilio && (!config.twilio.fromNumber?.trim() || hasPlaceholder(config.twilio.fromNumber))) issues.push("twilio.fromNumber");
  return issues;
}

function seamInventory(config: TenantProvisionConfig, secrets: ProvisionSecrets): DormantSeam[] {
  const active: Record<string, boolean> = {
    twilio: !!secrets.twilioSecret && !!config.twilio,
    financing: false, // cell 11 seam — owner picks vendor first
    postgrid: !!process.env.POSTGRID_API_KEY,
    quickbooks: !!process.env.NANGO_SECRET_KEY,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    docuseal: !!process.env.DOCUSEAL_API_KEY,
    roofr: !!process.env.ROOFR_API_KEY,
    companycam: !!process.env.NANGO_SECRET_KEY,
  };
  return DORMANT_SEAMS.map((s) => ({ ...s, active: active[s.key] ?? false }));
}

/**
 * Provision (or reconcile) a tenant. `dryRun` (default true) computes the plan
 * from config alone and writes NOTHING. `dryRun: false` executes every step
 * idempotently and returns a provisioning.complete artifact.
 */
export async function provisionTenant(
  config: TenantProvisionConfig,
  secrets: ProvisionSecrets = {},
  opts: { dryRun?: boolean } = {},
): Promise<ProvisionResult> {
  const dryRun = opts.dryRun ?? true;
  const timezone = config.timezone ?? DEFAULT_TZ;
  const steps: ProvisionStep[] = [];
  const dormantSeams = seamInventory(config, secrets);
  const warnings = findUnresolvedConfigFields(config);

  // Preflight: never create a broken tenant. A --commit with unresolved config
  // (leftover REPLACE placeholders / missing required fields) fails fast BEFORE
  // any DB write. Dry-run only warns (it's a preview of a template).
  if (!dryRun && warnings.length > 0) {
    throw new Error(
      `refusing to provision — unresolved config field(s): ${warnings.join(", ")}. Fill them in your provisioning JSON before running with --commit.`,
    );
  }

  // ---- DRY RUN: enumerate intent from config, touch nothing ----
  if (dryRun) {
    steps.push({ step: "tenant", action: "planned", detail: `ensure tenant "${config.name}" (${config.clerkOrgId}) tz=${timezone}` });
    steps.push({ step: "owner", action: "planned", detail: `ensure owner ${config.owner.email}` });
    steps.push({ step: "price_book", action: "planned", detail: "seed default price book if empty" });
    steps.push({ step: "licenses", action: "planned", detail: `ensure ${config.licenses.length} license row(s)` });
    steps.push({ step: "contract_templates", action: "planned", detail: `ensure ${(config.contractTemplates ?? []).length} contract template(s)` });
    steps.push({ step: "registry", action: "planned", detail: "seed global task registry + tenant_task_config" });
    steps.push({ step: "message_templates", action: "planned", detail: `ensure ${(config.messageTemplates ?? []).length} golden template(s)` });
    steps.push({
      step: "twilio",
      action: "planned",
      detail: config.twilio
        ? secrets.twilioSecret
          ? `wire Twilio ${config.twilio.fromNumber} + A2P pointers`
          : `Twilio ${config.twilio.fromNumber} left dormant (no secret supplied)`
        : "no Twilio config — dormant",
    });
    const artifact: ProvisionArtifact = {
      status: "complete",
      tenantId: "(dry-run)",
      clerkOrgId: config.clerkOrgId,
      name: config.name,
      timezone,
      provisionedAt: new Date().toISOString(),
      steps,
      dormantSeams,
    };
    return { dryRun: true, tenantId: "(dry-run)", created: false, steps, dormantSeams, artifact, warnings };
  }

  // ---- COMMIT ----
  // 1. Tenant (find-or-create) + operating config (Denver TZ, digest, break-glass).
  const t = await ensureTenantForOrg({ clerkOrgId: config.clerkOrgId, name: config.name });
  await adminDb
    .update(tenant)
    .set({
      name: config.name,
      timezone,
      ...(config.digestTimes ? { digestTimes: config.digestTimes } : {}),
      ...(config.breakGlass ? { breakGlass: config.breakGlass } : {}),
    })
    .where(eq(tenant.id, t.id));
  const tenantId = t.id;
  steps.push({ step: "tenant", action: t.created ? "created" : "updated", detail: `tenant ${tenantId} tz=${timezone}` });

  // 2. Owner user.
  const owner = await ensureUser({ tenantId, clerkUserId: config.owner.clerkUserId, name: config.owner.name, email: config.owner.email, role: "owner" });
  steps.push({ step: "owner", action: owner.created ? "created" : "updated", detail: config.owner.email });

  // 3. Price book (idempotent — seeds only when empty).
  const pb = await ensurePriceBook(tenantId);
  steps.push({ step: "price_book", action: pb.seeded > 0 ? "created" : "skipped", detail: `${pb.seeded} item(s) seeded` });

  // 3b. Good/Better/Best tier products (unpriced — owner fills costs; the
  // "price book needs costs" card surfaces until they do).
  const tp = await ensureTierProducts(tenantId);
  steps.push({ step: "tier_products", action: tp.seeded > 0 ? "created" : "skipped", detail: `${tp.seeded} tier product(s) seeded` });

  // 4. License matrix (skip an existing (state, city, number) row).
  let licAdded = 0;
  for (const l of config.licenses) {
    const cityPred = l.city == null ? isNull(license.city) : eq(license.city, l.city);
    const [existing] = await adminDb
      .select({ id: license.id })
      .from(license)
      .where(and(eq(license.tenantId, tenantId), eq(license.state, l.state), cityPred, eq(license.licenseNumber, l.licenseNumber)));
    if (existing) continue;
    await adminDb.insert(license).values({ tenantId, state: l.state, city: l.city ?? null, authority: l.authority, licenseNumber: l.licenseNumber, status: l.status ?? "active" });
    licAdded++;
  }
  steps.push({ step: "licenses", action: licAdded > 0 ? "created" : "skipped", detail: `${licAdded} added, ${config.licenses.length - licAdded} already present` });

  // 5. Contract templates (unique on (tenant, state, version) → do-nothing on conflict).
  let tmplAdded = 0;
  for (const c of config.contractTemplates ?? []) {
    const res = await adminDb
      .insert(contractTemplate)
      .values({ tenantId, state: c.state, version: c.version ?? 1, name: c.name, clauses: c.clauses, status: c.status ?? "active", docusealTemplateId: null })
      .onConflictDoNothing({ target: [contractTemplate.tenantId, contractTemplate.state, contractTemplate.version] })
      .returning({ id: contractTemplate.id });
    tmplAdded += res.length;
  }
  steps.push({ step: "contract_templates", action: tmplAdded > 0 ? "created" : "skipped", detail: `${tmplAdded} added` });

  // 6. Global registry seed + per-tenant task config.
  const seeded = await seedTaskRegistry(adminDb);
  for (const cfg of config.taskConfig ?? []) {
    await adminDb
      .insert(tenantTaskConfig)
      .values({ tenantId, taskId: cfg.taskId, enabled: cfg.enabled ?? true, mode: cfg.mode ?? null })
      .onConflictDoUpdate({
        target: [tenantTaskConfig.tenantId, tenantTaskConfig.taskId],
        set: { enabled: cfg.enabled ?? true, mode: cfg.mode ?? null, updatedAt: new Date() },
      });
  }
  steps.push({ step: "registry", action: "updated", detail: `${seeded} registry rows; ${(config.taskConfig ?? []).length} tenant config(s)` });

  // 7. Golden-set message templates (unique on (tenant, key) → do-nothing).
  let msgAdded = 0;
  for (const m of config.messageTemplates ?? []) {
    const res = await adminDb
      .insert(messageTemplate)
      .values({ tenantId, key: m.key, name: m.name, channel: m.channel, subject: m.subject ?? null, body: m.body, aiCapability: m.aiCapability ?? null })
      .onConflictDoNothing({ target: [messageTemplate.tenantId, messageTemplate.key] })
      .returning({ id: messageTemplate.id });
    msgAdded += res.length;
  }
  steps.push({ step: "message_templates", action: msgAdded > 0 ? "created" : "skipped", detail: `${msgAdded} added` });

  // 8. Twilio wiring — only when a secret is supplied (never from config). Otherwise dormant.
  if (config.twilio && secrets.twilioSecret) {
    await upsertTwilioConnection(tenantId, { secret: secrets.twilioSecret, fromNumber: config.twilio.fromNumber });
    if (config.twilio.a2p) await setA2pRegistration(tenantId, config.twilio.a2p);
    steps.push({ step: "twilio", action: "created", detail: `wired ${config.twilio.fromNumber} (sealed secret); A2P pointers set` });
  } else {
    steps.push({ step: "twilio", action: "skipped", detail: "dormant — no secret supplied (owner completes at execution)" });
  }

  const artifact: ProvisionArtifact = {
    status: "complete",
    tenantId,
    clerkOrgId: config.clerkOrgId,
    name: config.name,
    timezone,
    provisionedAt: new Date().toISOString(),
    steps,
    dormantSeams,
  };
  return { dryRun: false, tenantId, created: t.created, steps, dormantSeams, artifact, warnings };
}
