import { and, eq } from "drizzle-orm";
import { seal, open, type SealedSecret, type IntegrationStatus, type TelephonyMode } from "@savvy/core";
import { adminDb } from "../admin-client.js";
import { withTenant } from "../tenant.js";
import { tenant, integrationConnection } from "../schema/index.js";

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
  provider: "twilio",
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
  return {
    source: "tenant",
    twilio: { accountSid: secret.accountSid, authToken: secret.authToken, from: view.fromNumber ?? "" },
  };
}

export async function disconnectTelephony(tenantId: string, provider: "twilio"): Promise<void> {
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
