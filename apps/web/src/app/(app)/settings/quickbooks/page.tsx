import { getTenantId } from "@/lib/tenant";
import { adminDb, tenant, eq } from "@savvy/db";
import { ConnectQuickBooksButton } from "./ConnectQuickBooksButton";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

export default async function QuickBooksSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const connectedFlag = sp.connected === "1";
  const errorCode = typeof sp.error === "string" ? sp.error : undefined;

  const tenantId = await getTenantId();

  // Read qboConnectionId directly from the tenant row via adminDb (tenant has no RLS).
  // Mirrors getStripeConnection() pattern in settings/payments.
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  const connected = Boolean(t?.qboConnectionId);
  const connectionId = t?.qboConnectionId ?? undefined;

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader eyebrow="Integration" title="QuickBooks" />
      <p className="text-sm text-muted-foreground">
        Connect your QuickBooks Online account to sync invoices and payments automatically.
      </p>
      <ConnectQuickBooksButton
        connected={connected}
        connectionId={connectionId}
        connectedFlag={connectedFlag}
        errorCode={errorCode}
      />
    </div>
  );
}
