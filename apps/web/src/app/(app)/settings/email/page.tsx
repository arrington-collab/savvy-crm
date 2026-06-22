import { getTenantId } from "@/lib/tenant";
import { adminDb, tenant, eq } from "@savvy/db";
import { ConnectGmailButton } from "./ConnectGmailButton";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const connectedFlag = sp.connected === "1";
  const errorCode = typeof sp.error === "string" ? sp.error : undefined;

  const tenantId = await getTenantId();

  // Read gmailConnectionId from tenant.settings jsonb via adminDb (tenant has no RLS).
  // Mirrors the qboConnectionId pattern in settings/quickbooks/page.tsx.
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = (t?.settings as Record<string, unknown>) ?? {};
  const emailSettings = (settings.email as Record<string, unknown>) ?? {};
  const gmailConnectionId = typeof emailSettings.gmailConnectionId === "string"
    ? emailSettings.gmailConnectionId
    : undefined;
  const connected = Boolean(gmailConnectionId);

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader eyebrow="Integration" title="Gmail" />
      <p className="text-sm text-muted-foreground">
        Connect your Google account to send Savvy emails from your own Gmail address.
      </p>
      <ConnectGmailButton
        connected={connected}
        connectionId={gmailConnectionId}
        connectedFlag={connectedFlag}
        errorCode={errorCode}
      />
    </div>
  );
}
