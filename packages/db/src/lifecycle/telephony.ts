import { and, eq, sql } from "drizzle-orm";
import { seal, open, type SealedSecret, type IntegrationStatus, type TelephonyMode } from "@savvy/core";
import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { tenant, integrationConnection } from "../schema/index";

export interface TwilioSecret {
  accountSid: string;
  authToken: string;
}

export interface TelephonyConnectionView {
  provider: "twilio";
  status: IntegrationStatus;
  fromNumber: string | null;
  lastVerifiedAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface ManagedSetupRequest {
  tenantId: string;
  provider: "twilio";
  requestedBy: string | null;
  requestedAt: string | null;
  feeNote: string | null;
}

export async function getTelephonyMode(tenantId: string): Promise<TelephonyMode> {
  const [t] = await adminDb.select({ mode: tenant.telephonyMode }).from(tenant).where(eq(tenant.id, tenantId));
  return (t?.mode ?? "platform") as TelephonyMode;
}

export async function setTelephonyMode(tenantId: string, mode: TelephonyMode): Promise<void> {
  await adminDb.update(tenant).set({ telephonyMode: mode }).where(eq(tenant.id, tenantId));
}

export async function upsertTwilioConnection(
  tenantId: string,
  input: { secret: TwilioSecret; fromNumber: string },
): Promise<void> {
  const sealed = seal(JSON.stringify(input.secret));
  await withTenant(tenantId, (tx) =>
    tx
      .insert(integrationConnection)
      .values({
        tenantId,
        provider: "twilio",
        status: "pending",
        secretCiphertext: sealed.ciphertext,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
        keyVersion: sealed.keyVersion,
        metadata: { fromNumber: input.fromNumber },
      })
      .onConflictDoUpdate({
        target: [integrationConnection.tenantId, integrationConnection.provider],
        set: {
          status: "pending",
          secretCiphertext: sealed.ciphertext,
          secretIv: sealed.iv,
          secretTag: sealed.tag,
          keyVersion: sealed.keyVersion,
          metadata: { fromNumber: input.fromNumber },
          lastVerifiedAt: null,
          updatedAt: new Date(),
        },
      }),
  );
}

export async function getTelephonyConnection(
  tenantId: string,
  provider: "twilio",
): Promise<TelephonyConnectionView | null> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, provider))),
  );
  const row = rows[0];
  if (!row) return null;
  const metadata = row.metadata ?? {};
  return {
    provider: "twilio",
    status: row.status as IntegrationStatus,
    fromNumber: typeof metadata.fromNumber === "string" ? metadata.fromNumber : null,
    lastVerifiedAt: row.lastVerifiedAt ?? null,
    metadata,
  };
}

/** Server-only. Decrypts the stored secret. Never expose the result to a client. */
export async function getTwilioSecret(tenantId: string): Promise<TwilioSecret | null> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "twilio"))),
  );
  const row = rows[0];
  if (!row) return null;
  const sealed: SealedSecret = {
    ciphertext: row.secretCiphertext,
    iv: row.secretIv,
    tag: row.secretTag,
    keyVersion: row.keyVersion,
  };
  return JSON.parse(open(sealed)) as TwilioSecret;
}

export async function setTelephonyConnectionStatus(
  tenantId: string,
  provider: "twilio" | "vapi",
  status: IntegrationStatus,
  opts?: { verifiedNow?: boolean },
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx
      .update(integrationConnection)
      .set({
        status,
        updatedAt: new Date(),
        ...(opts?.verifiedNow ? { lastVerifiedAt: new Date() } : {}),
      })
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, provider))),
  );
}

export async function requestManagedTelephonySetup(
  tenantId: string,
  provider: "twilio",
  opts: { requestedBy: string; feeNote?: string },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ metadata: integrationConnection.metadata })
      .from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, provider)));
    const prior = rows[0]?.metadata ?? {};
    await tx
      .update(integrationConnection)
      .set({
        status: "setup_requested",
        metadata: {
          ...prior,
          requestedBy: opts.requestedBy,
          requestedAt: new Date().toISOString(),
          ...(opts.feeNote ? { feeNote: opts.feeNote } : {}),
        },
        updatedAt: new Date(),
      })
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, provider)));
  });
}

export interface ResolvedTwilioCreds {
  accountSid: string;
  authToken: string;
  from: string;
}

export type TelephonyResolution =
  | { source: "platform" | "tenant"; twilio: ResolvedTwilioCreds }
  | { source: "inactive" };

/**
 * Resolve Twilio creds for a tenant.
 * - platform mode → global env creds (today's behavior).
 * - byo + active connection → the tenant's own decrypted creds.
 * - byo + nothing active → inactive (caller must not send).
 */
export async function resolveTelephonyCreds(tenantId: string): Promise<TelephonyResolution> {
  const mode = await getTelephonyMode(tenantId);
  if (mode === "platform") {
    return {
      source: "platform",
      twilio: {
        accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
        authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
        from: process.env.TWILIO_FROM ?? "+15555550000",
      },
    };
  }
  const view = await getTelephonyConnection(tenantId, "twilio");
  if (!view || view.status !== "active") return { source: "inactive" };
  const secret = await getTwilioSecret(tenantId);
  if (!secret) return { source: "inactive" };
  // Phase 2: the send path MUST reject empty accountSid/from before sending
  // (a managed-setup placeholder row can be active with empty creds).
  return {
    source: "tenant",
    twilio: { accountSid: secret.accountSid, authToken: secret.authToken, from: view.fromNumber ?? "" },
  };
}

export async function disconnectTelephony(tenantId: string, provider: "twilio" | "vapi"): Promise<void> {
  await setTelephonyConnectionStatus(tenantId, provider, "disabled");
}

/** Ops view: every pending managed-setup request across all tenants (RLS-bypassing). */
export async function listManagedSetupRequests(): Promise<ManagedSetupRequest[]> {
  const rows = await adminDb
    .select({ tenantId: integrationConnection.tenantId, metadata: integrationConnection.metadata })
    .from(integrationConnection)
    .where(eq(integrationConnection.status, "setup_requested"));
  return rows.map((r) => {
    const m = r.metadata ?? {};
    return {
      tenantId: r.tenantId,
      provider: "twilio" as const,
      requestedBy: typeof m.requestedBy === "string" ? m.requestedBy : null,
      requestedAt: typeof m.requestedAt === "string" ? m.requestedAt : null,
      feeNote: typeof m.feeNote === "string" ? m.feeNote : null,
    };
  });
}

// ─── Vapi connection lifecycle ───────────────────────────────────────────────

export interface VapiSecret {
  apiKey: string;
}

export interface VapiConnectionView {
  provider: "vapi";
  status: IntegrationStatus;
  assistantId: string | null;
  phoneNumberId: string | null;
  lastVerifiedAt: Date | null;
}

export async function upsertVapiConnection(
  tenantId: string,
  input: { secret: VapiSecret; assistantId: string; phoneNumberId: string },
): Promise<void> {
  const sealed = seal(JSON.stringify(input.secret));
  await withTenant(tenantId, (tx) =>
    tx
      .insert(integrationConnection)
      .values({
        tenantId,
        provider: "vapi",
        status: "pending",
        secretCiphertext: sealed.ciphertext,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
        keyVersion: sealed.keyVersion,
        metadata: { assistantId: input.assistantId, phoneNumberId: input.phoneNumberId },
      })
      .onConflictDoUpdate({
        target: [integrationConnection.tenantId, integrationConnection.provider],
        set: {
          status: "pending",
          secretCiphertext: sealed.ciphertext,
          secretIv: sealed.iv,
          secretTag: sealed.tag,
          keyVersion: sealed.keyVersion,
          metadata: { assistantId: input.assistantId, phoneNumberId: input.phoneNumberId },
          lastVerifiedAt: null,
          updatedAt: new Date(),
        },
      }),
  );
}

/** Returns the Vapi connection view — never includes apiKey. */
export async function getVapiConnection(tenantId: string): Promise<VapiConnectionView | null> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "vapi"))),
  );
  const row = rows[0];
  if (!row) return null;
  const m = row.metadata ?? {};
  return {
    provider: "vapi",
    status: row.status as IntegrationStatus,
    assistantId: typeof m.assistantId === "string" ? m.assistantId : null,
    phoneNumberId: typeof m.phoneNumberId === "string" ? m.phoneNumberId : null,
    lastVerifiedAt: row.lastVerifiedAt ?? null,
  };
}

/** Server-only. Decrypts the stored Vapi secret. Never expose the result to a client. */
export async function getVapiSecret(tenantId: string): Promise<VapiSecret | null> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(integrationConnection)
      .where(and(eq(integrationConnection.tenantId, tenantId), eq(integrationConnection.provider, "vapi"))),
  );
  const row = rows[0];
  if (!row) return null;
  const sealed: SealedSecret = {
    ciphertext: row.secretCiphertext,
    iv: row.secretIv,
    tag: row.secretTag,
    keyVersion: row.keyVersion,
  };
  return JSON.parse(open(sealed)) as VapiSecret;
}

export type VoiceResolution =
  | { source: "platform" | "tenant"; vapi: { apiKey: string; assistantId: string; phoneNumberId: string } }
  | { source: "inactive" };

/**
 * Reverse lookup: the tenant id owning an ACTIVE vapi connection whose
 * assistantId matches. Cross-tenant (adminDb) because the tenant is unknown
 * at inbound time. Mirrors the metadata->>'' filter used elsewhere.
 */
export async function tenantByVapiAssistant(assistantId: string): Promise<string | null> {
  if (!assistantId) return null;
  const rows = await adminDb
    .select({ tenantId: integrationConnection.tenantId })
    .from(integrationConnection)
    .where(
      and(
        eq(integrationConnection.provider, "vapi"),
        eq(integrationConnection.status, "active"),
        sql`${integrationConnection.metadata}->>'assistantId' = ${assistantId}`,
      ),
    );
  return rows[0]?.tenantId ?? null;
}

/**
 * Resolve Vapi creds for a tenant.
 * - platform mode → global env creds (VAPI_API_KEY / VAPI_ASSISTANT_ID / VAPI_PHONE_NUMBER_ID).
 * - byo + active connection → the tenant's own decrypted creds.
 * - byo + nothing active → inactive (caller must not place calls).
 */
export async function resolveVoiceCreds(tenantId: string): Promise<VoiceResolution> {
  const mode = await getTelephonyMode(tenantId);
  if (mode === "platform") {
    return {
      source: "platform",
      vapi: {
        apiKey: process.env.VAPI_API_KEY ?? "",
        assistantId: process.env.VAPI_ASSISTANT_ID ?? "",
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID ?? "",
      },
    };
  }
  const view = await getVapiConnection(tenantId);
  if (!view || view.status !== "active") return { source: "inactive" };
  const secret = await getVapiSecret(tenantId);
  if (!secret) return { source: "inactive" };
  return {
    source: "tenant",
    vapi: {
      apiKey: secret.apiKey,
      assistantId: view.assistantId ?? "",
      phoneNumberId: view.phoneNumberId ?? "",
    },
  };
}
